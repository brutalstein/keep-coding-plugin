(function_definition
  declarator: (function_declarator) @symbol.function.declarator) @symbol.function.definition

(declaration
  declarator: (function_declarator) @symbol.function.declarator) @symbol.function.declaration

(class_specifier
  name: (type_identifier) @symbol.class.name) @symbol.class.definition

(struct_specifier
  name: (type_identifier) @symbol.struct.name) @symbol.struct.definition

(enum_specifier
  name: (type_identifier) @symbol.enum.name) @symbol.enum.definition

(namespace_definition
  name: (_) @symbol.namespace.name) @symbol.namespace.definition

(preproc_include
  path: (_) @import.path) @import.statement

(call_expression
  function: (_) @reference.call.target) @reference.call
