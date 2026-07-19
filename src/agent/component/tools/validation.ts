export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * 校验工具当前使用的 JSON Schema 子集。
 *
 * 支持 object/array/string/number/integer/boolean/null、required、
 * properties、additionalProperties、items、enum、const 及常用长度/数值限制。
 * 有意拒绝无法识别的基础类型，但不会假装支持完整 JSON Schema draft。
 */
export function validateToolArguments(
  schema: Record<string, any>,
  value: unknown
): ValidationResult {
  const errors: string[] = [];
  validateNode(schema || {}, value, '$', errors);
  return { valid: errors.length === 0, errors };
}

function validateNode(
  schema: Record<string, any>,
  value: unknown,
  location: string,
  errors: string[]
): void {
  if (Array.isArray(schema.anyOf)) {
    const valid = schema.anyOf.some((candidate: Record<string, any>) =>
      validateToolArguments(candidate, value).valid
    );
    if (!valid) errors.push(`${location} does not match any allowed schema`);
    return;
  }

  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((candidate: Record<string, any>) =>
      validateToolArguments(candidate, value).valid
    ).length;
    if (matches !== 1) errors.push(`${location} must match exactly one schema`);
    return;
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((item: unknown) => Object.is(item, value))) {
    errors.push(`${location} must be one of ${JSON.stringify(schema.enum)}`);
  }
  if (Object.prototype.hasOwnProperty.call(schema, 'const') && !Object.is(schema.const, value)) {
    errors.push(`${location} must equal ${JSON.stringify(schema.const)}`);
  }

  const expectedTypes = Array.isArray(schema.type)
    ? schema.type
    : schema.type
      ? [schema.type]
      : schema.properties
        ? ['object']
        : [];

  if (expectedTypes.length > 0 && !expectedTypes.some((type: string) => matchesType(type, value))) {
    errors.push(`${location} must be ${expectedTypes.join(' or ')}`);
    return;
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    validateObject(schema, value as Record<string, unknown>, location, errors);
  } else if (Array.isArray(value)) {
    validateArray(schema, value, location, errors);
  } else if (typeof value === 'string') {
    validateString(schema, value, location, errors);
  } else if (typeof value === 'number') {
    validateNumber(schema, value, location, errors);
  }
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return false;
  }
}

function validateObject(
  schema: Record<string, any>,
  value: Record<string, unknown>,
  location: string,
  errors: string[]
): void {
  const properties = schema.properties || {};
  const required: string[] = Array.isArray(schema.required) ? schema.required : [];

  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      errors.push(`${location}.${key} is required`);
    }
  }

  for (const [key, childValue] of Object.entries(value)) {
    if (properties[key]) {
      validateNode(properties[key], childValue, `${location}.${key}`, errors);
    } else if (schema.additionalProperties === false) {
      errors.push(`${location}.${key} is not allowed`);
    } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      validateNode(schema.additionalProperties, childValue, `${location}.${key}`, errors);
    }
  }
}

function validateArray(
  schema: Record<string, any>,
  value: unknown[],
  location: string,
  errors: string[]
): void {
  if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
    errors.push(`${location} must contain at least ${schema.minItems} items`);
  }
  if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
    errors.push(`${location} must contain at most ${schema.maxItems} items`);
  }
  if (schema.items && typeof schema.items === 'object') {
    value.forEach((item, index) => validateNode(schema.items, item, `${location}[${index}]`, errors));
  }
}

function validateString(
  schema: Record<string, any>,
  value: string,
  location: string,
  errors: string[]
): void {
  if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
    errors.push(`${location} must contain at least ${schema.minLength} characters`);
  }
  if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
    errors.push(`${location} must contain at most ${schema.maxLength} characters`);
  }
  if (typeof schema.pattern === 'string') {
    try {
      if (!new RegExp(schema.pattern).test(value)) {
        errors.push(`${location} must match ${schema.pattern}`);
      }
    } catch {
      errors.push(`${location} has an invalid schema pattern`);
    }
  }
}

function validateNumber(
  schema: Record<string, any>,
  value: number,
  location: string,
  errors: string[]
): void {
  if (typeof schema.minimum === 'number' && value < schema.minimum) {
    errors.push(`${location} must be >= ${schema.minimum}`);
  }
  if (typeof schema.maximum === 'number' && value > schema.maximum) {
    errors.push(`${location} must be <= ${schema.maximum}`);
  }
}
