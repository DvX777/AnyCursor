'use strict';

/**
 * Append-only AvailableModels merge.
 *
 * Cursor's response is protobuf. We do not decode/rebuild native models: we
 * append AnyCursor model messages to the existing repeated fields. If anything
 * here fails, the caller can return the original bytes untouched.
 *
 * AvailableModelsResponse.AvailableModel (3.27.22):
 *  1 name, 5 supports_agent, 9 supports_thinking, 10 supports_images,
 *  17 client_display_name, 18 server_model_name, 19 supports_non_max_mode,
 *  22 supports_plan_mode, 23 is_user_added, 24 inputbox_short_model_name,
 *  29 parameter_definitions, 30 variants, 38 named_model_section_index,
 *  39 tagline, 41 vendor_name
 */

function varint(value) {
  const out = [];
  let v = Number(value) >>> 0;
  while (v > 0x7f) { out.push((v & 0x7f) | 0x80); v >>>= 7; }
  out.push(v);
  return Buffer.from(out);
}

function tag(field, wire) {
  return varint((field << 3) | wire);
}

function ld(field, buf) {
  const body = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf));
  return Buffer.concat([tag(field, 2), varint(body.length), body]);
}

function vi(field, value) {
  return Buffer.concat([tag(field, 0), varint(value)]);
}

function str(field, value) {
  return value === undefined || value === null || value === '' ? Buffer.alloc(0) : ld(field, String(value));
}

function readFields(buf) {
  const out = [];
  if (!Buffer.isBuffer(buf)) return out;
  let i = 0;
  while (i < buf.length) {
    let key;
    try { [key, i] = rv(buf, i); } catch (_) { break; }
    const no = key >>> 3;
    const wire = key & 7;
    if (wire === 0) {
      let v; try { [v, i] = rv(buf, i); } catch (_) { break; }
      out.push({ no, wire, value: v });
    } else if (wire === 2) {
      let len; try { [len, i] = rv(buf, i); } catch (_) { break; }
      if (i + len > buf.length) break;
      out.push({ no, wire, value: buf.subarray(i, i + len) });
      i += len;
    } else if (wire === 5) {
      out.push({ no, wire, value: buf.subarray(i, i + 4) }); i += 4;
    } else if (wire === 1) {
      out.push({ no, wire, value: buf.subarray(i, i + 8) }); i += 8;
    } else {
      break;
    }
  }
  return out;
}

function rv(buf, i) {
  let shift = 0;
  let val = 0;
  while (true) {
    if (i >= buf.length) throw new RangeError('eof');
    const c = buf[i++];
    val |= (c & 0x7f) << shift;
    if (!(c & 0x80)) return [val, i];
    shift += 7;
  }
}

function enumParameter(id, name, values, tooltip) {
  const encodedValues = values.map((value) => ld(1, Buffer.concat([
    ld(1, String(value.id)),
    ld(2, String(value.label || value.id)),
  ])));
  const enumDefinition = Buffer.concat(encodedValues); // EnumParameterDefinition.values[]
  const parameterType = ld(2, enumDefinition);          // ModelParameterType.enum_parameter
  return Buffer.concat([
    ld(1, String(id)),
    ld(2, String(name)),
    tooltip ? ld(3, String(tooltip)) : Buffer.alloc(0),
    ld(4, parameterType),
    vi(5, 1),                                           // is_cycleable_by_hotkey
  ]);
}

function booleanParameter(id, name, values, tooltip) {
  const encodedValues = values.map((value) => ld(1, Buffer.concat([
    ld(1, String(value.value)),
    value.label ? ld(2, String(value.label)) : Buffer.alloc(0),
  ])));
  const booleanDefinition = Buffer.concat(encodedValues); // BooleanParameterDefinition.values[]
  const parameterType = ld(1, booleanDefinition);          // ModelParameterType.boolean_parameter
  return Buffer.concat([
    ld(1, String(id)),
    ld(2, String(name)),
    tooltip ? ld(3, String(tooltip)) : Buffer.alloc(0),
    ld(4, parameterType),
  ]);
}

function parameterDefinitions(model) {
  const parts = [];
  if (model.effort && model.effort.tiers.length) {
    parts.push(enumParameter(
      'reasoning_effort',
      'Reasoning',
      model.effort.tiers,
      'Controls how much reasoning effort the model uses.',
    ));
  }
  if (model.contextOptions && model.contextOptions.length) {
    parts.push(enumParameter(
      'context',
      'Context',
      model.contextOptions,
      'Select the context window for this model.',
    ));
  }
  if (model.fast) {
    parts.push(booleanParameter('fast', 'Fast', [
      { value: 'false' },
      { value: 'true', label: 'Fast' },
    ], 'Significantly faster but consumes more usage.'));
  }
  return parts;
}

function parameterValue(id, value) {
  return Buffer.concat([
    ld(1, String(id)),
    ld(2, String(value)),
  ]);
}

function tooltipData(model, label) {
  const context = model.contextWindow ? `${Math.round(model.contextWindow / 1000)}K context window` : '';
  const title = label || model.displayName;
  const provider = model.providerLabel || 'AnyCursor';
  const markdown = `**${title}**\n\nServed by ${provider}.${context ? `\n\n${context}` : ''}`;
  return Buffer.concat([
    ld(1, title),
    ld(2, `Served by ${provider}.`),
    context ? ld(5, context) : Buffer.alloc(0),
    ld(7, markdown),
  ]);
}

function modelVariant(model, effort, context, fast) {
  const values = [];
  if (context) values.push(parameterValue('context', context.id));
  if (effort) values.push(parameterValue('reasoning_effort', effort.value === undefined ? effort.id : effort.value));
  if (model.fast) values.push(parameterValue('fast', fast ? 'true' : 'false'));

  const contexts = model.contextOptions || [];
  const defaultContext = contexts.length ? contexts[0] : null;
  const labelParts = [model.displayName];
  if (context && contexts.length > 1 && context.id !== defaultContext.id) labelParts.push(context.label);
  if (effort) labelParts.push(effort.label || effort.id);
  if (fast) labelParts.push('Fast');
  const displayName = labelParts.join(' ');
  const isDefault = (!effort || effort.id === model.effort.default)
    && (!context || !defaultContext || context.id === defaultContext.id)
    && !fast;

  const representation = `${model.cursorId}[${[
    context ? `context=${context.id}` : '',
    effort ? `reasoning_effort=${effort.value === undefined ? effort.id : effort.value}` : '',
    model.fast ? `fast=${fast ? 'true' : 'false'}` : '',
  ].filter(Boolean).join(',')}]`;

  return Buffer.concat([
    ld(1, Buffer.concat(values)),
    ld(2, displayName),
    ld(7, model.providerLabel || ''),
    ld(8, displayName),
    vi(5, isDefault ? 1 : 0),
    ld(9, representation),
    ld(6, tooltipData(model, displayName)),
  ]);
}

function encodeAvailableModel(model) {
  const parts = [];
  parts.push(ld(1, model.cursorId));
  parts.push(vi(2, 1));     // default_on
  if (model.capabilities.tools) {
    parts.push(vi(5, 1));   // supports_agent
    parts.push(vi(22, 1));  // supports_plan_mode
  }
  if (model.capabilities.reasoning) parts.push(vi(9, 1));
  if (model.capabilities.vision) parts.push(vi(10, 1));
  parts.push(vi(19, 1));    // supports_non_max_mode
  parts.push(vi(23, 1));    // is_user_added (keep the selected native BYOK entry alive until migration)
  if (model.contextWindow) parts.push(vi(15, model.contextWindow));
  if (model.contextOptions && model.contextOptions.length) {
    const maxContext = model.contextOptions.reduce((max, option) => Math.max(max, option.value || 0), 0);
    if (maxContext) parts.push(vi(16, maxContext));
  }
  parts.push(ld(17, model.displayName));
  parts.push(ld(18, model.cursorId));
  parts.push(ld(24, model.shortName));
  parts.push(ld(39, model.providerLabel));
  if (model.vendor) parts.push(ld(41, model.vendor));
  parts.push(vi(38, 0));    // named_model_section_index
  parts.push(ld(8, tooltipData(model)));

  for (const definition of parameterDefinitions(model)) parts.push(ld(29, definition));

  const contexts = model.contextOptions && model.contextOptions.length ? model.contextOptions : [null];
  const efforts = model.effort && model.effort.tiers.length ? model.effort.tiers : [null];
  const fasts = model.fast ? [false, true] : [false];
  if (model.effort || (model.contextOptions && model.contextOptions.length) || model.fast) {
    for (const context of contexts) {
      for (const effort of efforts) {
        for (const fast of fasts) {
          parts.push(ld(30, modelVariant(model, effort, context, fast)));
        }
      }
    }
  }
  return Buffer.concat(parts);
}

/**
 * Append AnyCursor models and names to a raw AvailableModelsResponse.
 * Native bytes are preserved exactly; only new fields are appended.
 */
function appendModels(raw, models, selectedIds = []) {
  let out = Buffer.isBuffer(raw) ? raw : Buffer.from(raw || []);
  const usable = (models || []).filter((model) => model && model.enabled !== false);
  const selected = new Set(selectedIds || []);
  for (const model of usable) {
    // Cursor may have the namespaced id and/or a legacy id saved in different
    // old conversations. Expose every selected id for this model; otherwise a
    // chat using the missing id falls back to Auto.
    const ids = [model.cursorId, ...(model.legacyIds || [])];
    const selectedForModel = ids.filter((id) => selected.has(id));
    const visibleIds = selectedForModel.length
      ? selectedForModel
      : [(model.legacyIds || []).find(Boolean) || model.cursorId];
    for (const primaryId of visibleIds) {
      const entry = { ...model, cursorId: primaryId, serverModelName: primaryId, legacyIds: [] };
      out = Buffer.concat([
        out,
        ld(2, encodeAvailableModel(entry)),
        ld(1, entry.cursorId),
      ]);
    }
  }
  if (usable.some((model) => (model.effort && model.effort.tiers.length) || (model.contextOptions || []).length || model.fast)) {
    out = Buffer.concat([out, vi(11, 1)]); // use_model_parameters
  }
  return out;
}

module.exports = {
  encodeAvailableModel,
  appendModels,
  parameterDefinitions,
  modelVariant,
  readFields,
};
