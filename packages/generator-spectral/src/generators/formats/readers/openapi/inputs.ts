import { OpenAPI, OpenAPIV3, OpenAPIV3_1 } from "openapi-types";
import { startCase, merge } from "lodash";
import { Input, cleanIdentifier, stripUndefined } from "../../utils";
import { InputFieldChoice, InputFieldType } from "@prismatic-io/spectral";

type ParameterObject = OpenAPIV3.ParameterObject | OpenAPIV3_1.ParameterObject;

const toInputType = (type: string, required: boolean): {  
    type: InputFieldType;
    language?: string;
    clean: string;
  } => {

  switch(type) {
    case "integer":
    case "number":
      return {
        type: "string",
        clean: required
          ? "(value): number => util.types.toNumber(value)"
          : "(value): number | undefined => (typeof value === 'undefined' || value === '') ? undefined : util.types.toNumber(value)",
      };

    case "boolean":
      return {
        type: "boolean",
        clean: required
          ? "(value): boolean => util.types.toBool(value)"
          : "(value): boolean | undefined => (typeof value === 'undefined' || value === '') ? undefined : util.types.toBool(value)",
      };

    case "object":
    case "array":
      return {
        type: "code",
        language: "json",
        clean: "(value): any => util.types.toObject(value) || undefined",
      };

    default:
      return {
        type: "string",
        clean: "(value): string | undefined => util.types.toString(value)",
      };  
  }
};

const getInputModel = (
  schema: OpenAPIV3.SchemaObject | OpenAPIV3_1.SchemaObject
): InputFieldChoice[] | undefined => {
  if (schema?.type === "boolean") {
    // No point generating model values for boolean
    return undefined;
  }

  if (schema?.enum) {
    return (schema?.enum ?? []).map<InputFieldChoice>((v) => ({
      label: startCase(v),
      value: v,
    }));
  }

  // Some schemas unnecessarily nest inside of an allOf so try to handle those.
  if (schema?.allOf && schema?.allOf?.[0] && !("$ref" in schema?.allOf?.[0])) {
    return (schema?.allOf?.[0]?.enum ?? []).map<InputFieldChoice>((v) => ({
      label: startCase(v),
      value: v,
    }));
  }

  return undefined;
};

const buildInput = (
  parameter: OpenAPI.Parameter,
  seenKeys: Set<string>
): Input => {
  if ("$ref" in parameter) {
    throw new Error("$ref nodes are not supported.");
  }

  const schemaType = parameter.schema?.type;
  const required = parameter.required || false;  
  const { type, language, clean } = toInputType(schemaType, required);

  const { name: paramKey } = parameter;
  const key = seenKeys.has(cleanIdentifier(paramKey))
    ? cleanIdentifier(`other ${paramKey}`)
    : cleanIdentifier(paramKey);
  seenKeys.add(key);

  const model = getInputModel(parameter.schema);

  const input = stripUndefined<Input>({
    upstreamKey: paramKey,
    key,
    label: startCase(paramKey),
    type,
    language,
    required,
    comments: parameter.description,
    default: parameter.schema?.default,
    example: parameter.schema?.example,
    model,
    clean,
  });
  return input;
};

const getProperties = (
  schema: OpenAPIV3.SchemaObject | OpenAPIV3_1.SchemaObject
): Record<string, OpenAPIV3.SchemaObject | OpenAPIV3_1.SchemaObject> => {
  if (!schema.properties && !schema.allOf) {
    return { "value": schema };
  }

  return merge(
    schema.properties ?? {},
    ...(schema.allOf ?? []).map((v) => (v as any).properties) // FIXME: any usage
  ) as Record<string, OpenAPIV3.SchemaObject | OpenAPIV3_1.SchemaObject>;
};

const buildBodyInputs = (
  schema: OpenAPIV3.SchemaObject | OpenAPIV3_1.SchemaObject,
  seenKeys: Set<string>
): Input[] => {
  const requiredKeys = new Set(schema.required ?? []);
  const properties = getProperties(schema);

  return Object.entries(properties)
    .filter(([_propKey, prop]) => !prop.readOnly) // Don't create inputs for readonly properties
    .map<Input>(([propKey, prop]) => {
      const schemaType = prop?.type;
      const required = requiredKeys.has(propKey);
      const { type, language, clean } = toInputType(schemaType as string ?? "string", required);

      const model = getInputModel(prop);

      const key = seenKeys.has(cleanIdentifier(propKey))
        ? cleanIdentifier(`other ${propKey}`)
        : cleanIdentifier(propKey);
      seenKeys.add(key);

      return stripUndefined<Input>({
        upstreamKey: propKey,
        key,
        label: startCase(propKey),
        type,
        language,
        required,
        comments: prop.description,
        default: prop.default,
        example: prop.example,
        model,
        clean,
      });
    });
};

export const getInputs = (
  operation: OpenAPIV3.OperationObject | OpenAPIV3_1.OperationObject,
  sharedParameters: ParameterObject[] = []
): {
  pathInputs: Input[];
  queryInputs: Input[];
  bodyInputs: Input[];
  payloadContentType: string;
} => {
  if (
    typeof operation.requestBody !== "undefined" &&
    "$ref" in operation.requestBody
  ) {
    throw new Error("All refs should be resolved before computing Inputs.");
  }

  const seenKeys = new Set<string>(["connection"]);

  // Merge in Path Item level parameters with the specific parameters to this Operation.
  // Some specs have the same input defined at path and at operation level. Dedupe them.
  const parameters = Object.values<ParameterObject>(
    [...sharedParameters, ...(operation.parameters ?? [])].reduce(
      (result, p) => {
        // Refs are unsupported.
        if ("$ref" in p) {
          return result;
        }

        return { ...result, [p.name]: p };
      },
      {}
    )
  );

  const pathInputs = (parameters ?? [])
    .filter((p) => p.in === "path")
    .map((p) => buildInput(p, seenKeys));

  const queryInputs = (parameters ?? [])
    .filter((p) => p.in === "query")
    .map((p) => buildInput(p, seenKeys));

  const requestBodySchema =
    operation.requestBody?.content?.["application/json"]?.schema;
  if (typeof requestBodySchema !== "undefined" && "$ref" in requestBodySchema) {
    throw new Error("All refs should be resolved before computing Inputs.");
  }
  const bodyInputs =
    requestBodySchema === undefined
      ? []
      : buildBodyInputs(requestBodySchema, seenKeys);

  return {
    pathInputs,
    queryInputs,
    bodyInputs,
    payloadContentType: "application/json",
  };
};
