export interface LangSpec {
  name: string;
  grammar: string; // tree-sitter-wasms grammar file suffix
  extensions: string[];
  defQuery: string;
  refQuery: string;
}

// Queries validated against tree-sitter-wasms grammars (web-tree-sitter 0.24).
// @def captures the whole definition node (for line range), @name the identifier.
// @name on a ref captures the callee name.
export const LANGS: LangSpec[] = [
  {
    name: "typescript",
    grammar: "typescript",
    extensions: [".ts", ".mts", ".cts"],
    defQuery: `
      (function_declaration name:(identifier)@name)@def
      (class_declaration name:(type_identifier)@name)@def
      (method_definition name:(property_identifier)@name)@def
      (interface_declaration name:(type_identifier)@name)@def
      (type_alias_declaration name:(type_identifier)@name)@def
      (enum_declaration name:(identifier)@name)@def
      (variable_declarator name:(identifier)@name value:[(arrow_function)(function_expression)])@def`,
    refQuery: `
      (call_expression function:(identifier)@name)@ref
      (call_expression function:(member_expression property:(property_identifier)@name))@ref`,
  },
  {
    name: "tsx",
    grammar: "tsx",
    extensions: [".tsx"],
    defQuery: `
      (function_declaration name:(identifier)@name)@def
      (class_declaration name:(type_identifier)@name)@def
      (method_definition name:(property_identifier)@name)@def
      (interface_declaration name:(type_identifier)@name)@def
      (type_alias_declaration name:(type_identifier)@name)@def
      (variable_declarator name:(identifier)@name value:[(arrow_function)(function_expression)])@def`,
    refQuery: `
      (call_expression function:(identifier)@name)@ref
      (call_expression function:(member_expression property:(property_identifier)@name))@ref`,
  },
  {
    name: "javascript",
    grammar: "javascript",
    extensions: [".js", ".mjs", ".cjs", ".jsx"],
    defQuery: `
      (function_declaration name:(identifier)@name)@def
      (class_declaration name:(identifier)@name)@def
      (method_definition name:(property_identifier)@name)@def
      (variable_declarator name:(identifier)@name value:[(arrow_function)(function_expression)])@def`,
    refQuery: `
      (call_expression function:(identifier)@name)@ref
      (call_expression function:(member_expression property:(property_identifier)@name))@ref`,
  },
  {
    name: "python",
    grammar: "python",
    extensions: [".py", ".pyi"],
    defQuery: `
      (function_definition name:(identifier)@name)@def
      (class_definition name:(identifier)@name)@def`,
    refQuery: `
      (call function:(identifier)@name)@ref
      (call function:(attribute attribute:(identifier)@name))@ref`,
  },
  {
    name: "go",
    grammar: "go",
    extensions: [".go"],
    defQuery: `
      (function_declaration name:(identifier)@name)@def
      (method_declaration name:(field_identifier)@name)@def
      (type_declaration (type_spec name:(type_identifier)@name))@def`,
    refQuery: `
      (call_expression function:(identifier)@name)@ref
      (call_expression function:(selector_expression field:(field_identifier)@name))@ref`,
  },
  {
    name: "java",
    grammar: "java",
    extensions: [".java"],
    defQuery: `
      (class_declaration name:(identifier)@name)@def
      (method_declaration name:(identifier)@name)@def
      (interface_declaration name:(identifier)@name)@def`,
    refQuery: `(method_invocation name:(identifier)@name)@ref`,
  },
  {
    name: "ruby",
    grammar: "ruby",
    extensions: [".rb"],
    defQuery: `
      (method name:(identifier)@name)@def
      (class name:(constant)@name)@def
      (module name:(constant)@name)@def`,
    refQuery: `(call method:(identifier)@name)@ref`,
  },
];

export function langForPath(path: string): LangSpec | undefined {
  const slash = path.lastIndexOf("/");
  const base = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = base.lastIndexOf(".");
  if (dot < 0) return undefined;
  const ext = base.slice(dot).toLowerCase();
  return LANGS.find((l) => l.extensions.includes(ext));
}

const KIND_MAP: Record<string, string> = {
  function_declaration: "function",
  function_definition: "function",
  method_definition: "method",
  method_declaration: "method",
  class_declaration: "class",
  class_definition: "class",
  interface_declaration: "interface",
  type_alias_declaration: "type",
  enum_declaration: "enum",
  type_declaration: "type",
  variable_declarator: "function",
  method: "method",
  class: "class",
  module: "module",
};

export function kindFromNodeType(type: string): string {
  return KIND_MAP[type] ?? "symbol";
}
