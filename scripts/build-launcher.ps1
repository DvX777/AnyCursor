param(
  [Parameter(Mandatory = $true)][string]$Node,
  [string]$OutDir = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($OutDir)) {
  $OutDir = Join-Path $env:LOCALAPPDATA "AnyCursor"
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$compilers = @(
  (Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"),
  (Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe")
)
$csc = $compilers | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $csc) {
  throw "C# compiler not found; install .NET Framework 4.x or use the Startup script fallback"
}

$source = @'
using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Reflection;
using System.Text.RegularExpressions;
using System.Threading;

[assembly: AssemblyTitle("AnyCursor Gateway")]
[assembly: AssemblyDescription("Hidden AnyCursor gateway prewarm helper. Users launch Cursor, not this file.")]
[assembly: AssemblyProduct("AnyCursor")]
[assembly: AssemblyCompany("AnyCursor")]
[assembly: AssemblyVersion("0.1.0.0")]
[assembly: AssemblyFileVersion("0.1.0.0")]

class AnyCursorLauncher
{
    static readonly string[] NodePaths = new string[] {
        @"__NODE__",
        @"C:\Program Files\nodejs\node.exe",
        @"C:\Program Files (x86)\nodejs\node.exe"
    };

    static volatile bool guardBusy = false;

    static string DataDir()
    {
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AnyCursor");
    }

    static string LogFile()
    {
        return Path.Combine(DataDir(), "launcher.log");
    }

    static void Log(string message)
    {
        try
        {
            Directory.CreateDirectory(DataDir());
            File.AppendAllText(LogFile(), DateTime.Now.ToString("s") + " " + message + Environment.NewLine);
        }
        catch { }
    }

    static string NodePath()
    {
        foreach (string path in NodePaths)
        {
            if (!String.IsNullOrEmpty(path) && File.Exists(path)) return path;
        }
        return "node.exe";
    }

    static string GatewayPath()
    {
        string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        string root = Path.Combine(home, ".cursor", "extensions");
        try
        {
            if (Directory.Exists(root))
            {
                string[] dirs = Directory.GetDirectories(root, "anycursor.anycursor-*");
                Array.Sort(dirs, delegate(string a, string b)
                {
                    return Directory.GetLastWriteTimeUtc(b).CompareTo(Directory.GetLastWriteTimeUtc(a));
                });
                foreach (string dir in dirs)
                {
                    string candidate = Path.Combine(dir, "vendor", "anycursor", "src", "gateway", "index.js");
                    if (File.Exists(candidate)) return candidate;
                }
            }
        }
        catch (Exception error)
        {
            Log("gateway scan failed: " + error.Message);
        }
        return null;
    }

    static string ConfigPath()
    {
        string configured = Environment.GetEnvironmentVariable("ANY_CURSOR_CONFIG");
        if (!String.IsNullOrEmpty(configured)) return configured;
        return Path.Combine(DataDir(), "config.json");
    }

    static bool Healthy(string host, int port)
    {
        try
        {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create("http://" + host + ":" + port + "/health");
            request.Timeout = 1200;
            request.ReadWriteTimeout = 1200;
            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
            {
                return (int)response.StatusCode == 200;
            }
        }
        catch
        {
            return false;
        }
    }

    static Process StartGateway(string gateway, string node, string config)
    {
        try
        {
            ProcessStartInfo info = new ProcessStartInfo();
            info.FileName = node;
            info.Arguments = "\"" + gateway + "\" --config \"" + config + "\"";
            info.WorkingDirectory = Path.GetDirectoryName(Path.GetDirectoryName(Path.GetDirectoryName(gateway)));
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.WindowStyle = ProcessWindowStyle.Hidden;
            Process child = Process.Start(info);
            Log("started gateway with " + node + " (pid " + child.Id + ")");
            return child;
        }
        catch (Exception error)
        {
            Log("gateway start failed: " + error.Message);
            return null;
        }
    }

    // Runs the shortcut guard from the hidden winexe supervisor. PowerShell is
    // started with CreateNoWindow so no console window flashes every minute;
    // the guard itself stays in %LOCALAPPDATA%\AnyCursor\bin.
    static void RunGuard(string config)
    {
        try
        {
            string guard = Path.Combine(DataDir(), "bin", "shortcut-guard.ps1");
            if (!File.Exists(guard)) return;

            ProcessStartInfo info = new ProcessStartInfo();
            info.FileName = "powershell.exe";
            info.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" + guard + "\" -Config \"" + config + "\" -Quiet";
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.WindowStyle = ProcessWindowStyle.Hidden;
            Process child = Process.Start(info);
            if (child != null)
            {
                if (!child.WaitForExit(30000))
                {
                    try { child.Kill(); } catch { }
                }
            }
        }
        catch (Exception error)
        {
            Log("guard failed: " + error.Message);
        }
    }

    static void GuardTick(string config)
    {
        if (guardBusy) return;
        guardBusy = true;
        Thread thread = new Thread(delegate()
        {
            try { RunGuard(config); }
            finally { guardBusy = false; }
        });
        thread.IsBackground = true;
        thread.Start();
    }

    // Keeps the gateway alive for windows that never load third-party extensions
    // (Cursor's Agent Window). The extension is an optional extra supervisor.
    static void Supervise(string config, string host, int port)
    {
        Log("supervisor started");
        bool patchShortcuts = true;
        try
        {
            if (File.Exists(config))
            {
                string text = File.ReadAllText(config);
                if (Regex.IsMatch(text, "\"patchShortcuts\"\\s*:\\s*false")) patchShortcuts = false;
            }
        }
        catch { }

        DateTime nextGuard = DateTime.MinValue;
        Process child = null;
        DateTime childStarted = DateTime.MinValue;

        while (true)
        {
            if (patchShortcuts && DateTime.UtcNow >= nextGuard)
            {
                GuardTick(config);
                nextGuard = DateTime.UtcNow.AddSeconds(60);
            }

            if (Healthy(host, port))
            {
                // The gateway may have been started by the login task, the
                // extension or a previous supervisor. Health is the truth.
                child = null;
                Thread.Sleep(2000);
                continue;
            }

            if (child != null)
            {
                if (!child.HasExited)
                {
                    // Give a fresh gateway time to bind, but never block the
                    // guard loop. Kill a process that stays unhealthy.
                    if ((DateTime.UtcNow - childStarted).TotalSeconds > 60)
                    {
                        Log("gateway did not become healthy; restarting it");
                        try { child.Kill(); } catch { }
                        try { child.WaitForExit(5000); } catch { }
                        child = null;
                    }
                    else
                    {
                        Thread.Sleep(2000);
                        continue;
                    }
                }
                else
                {
                    Log("gateway exited; checking again shortly");
                    child = null;
                    Thread.Sleep(5000);
                }
            }

            if (child != null) continue;

            string gateway = GatewayPath();
            if (gateway == null)
            {
                Log("gateway runtime not found under .cursor/extensions; retrying");
                Thread.Sleep(15000);
                continue;
            }

            child = StartGateway(gateway, NodePath(), config);
            childStarted = DateTime.UtcNow;
            if (child == null)
            {
                Thread.Sleep(15000);
                continue;
            }
            Thread.Sleep(1000);
        }
    }

    static void Main(string[] args)
    {
        bool watch = args != null && args.Length > 0 && args[0] == "--watch";
        string config = ConfigPath();
        string host = "127.0.0.1";
        int port = 43110;

        try
        {
            if (File.Exists(config))
            {
                string text = File.ReadAllText(config);
                Match blockMatch = Regex.Match(text, "\"gateway\"\\s*:\\s*\\{([^}]*)\\}", RegexOptions.Singleline);
                string block = blockMatch.Success ? blockMatch.Groups[1].Value : text;
                Match hostMatch = Regex.Match(block, "\"host\"\\s*:\\s*\"([^\"]+)\"");
                if (hostMatch.Success) host = hostMatch.Groups[1].Value;
                Match portMatch = Regex.Match(block, "\"port\"\\s*:\\s*(\\d+)");
                if (portMatch.Success) Int32.TryParse(portMatch.Groups[1].Value, out port);
            }
        }
        catch (Exception error)
        {
            Log("config read failed: " + error.Message);
        }

        if (watch)
        {
            Mutex mutex = new Mutex(false, "Local\\AnyCursorGatewaySupervisor");
            bool owned = false;
            try { owned = mutex.WaitOne(0); }
            catch (AbandonedMutexException) { owned = true; }
            if (!owned) return;
            Supervise(config, host, port);
            return;
        }

        if (Healthy(host, port)) return;

        string gateway = GatewayPath();
        if (gateway == null)
        {
            Log("gateway runtime not found under .cursor/extensions");
            return;
        }

        StartGateway(gateway, NodePath(), config);
    }
}
'@

$source = $source.Replace('__NODE__', $Node.Replace('"', '""'))
$sourceFile = Join-Path $OutDir 'AnyCursorLauncher.cs'
$exe = Join-Path $OutDir 'AnyCursor Gateway.exe'
Set-Content -Path $sourceFile -Value $source -Encoding UTF8

& $csc /nologo /target:winexe /optimize+ "/out:$exe" $sourceFile
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $exe)) {
  throw "launcher compilation failed"
}
Remove-Item $sourceFile -Force -ErrorAction SilentlyContinue
Write-Host "Built launcher: $exe" -ForegroundColor Green
