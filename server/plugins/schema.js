import Ajv from 'ajv';

export function compileParameters(schema) {
  if (schema?.$async) throw new Error('Asynchronous parameter schemas are not supported');
  const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
  return { ajv, validate: ajv.compile(schema) };
}

export function validateArguments(schema, args) {
  const { ajv, validate } = compileParameters(schema);
  if (!validate(args)) throw new Error(`Invalid tool arguments: ${ajv.errorsText(validate.errors)}`);
}
