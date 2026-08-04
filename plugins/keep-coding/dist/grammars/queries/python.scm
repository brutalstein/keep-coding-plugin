(function_definition
  name: (identifier) @symbol.function.name) @symbol.function.definition

(class_definition
  name: (identifier) @symbol.class.name) @symbol.class.definition

(import_statement) @import.statement
(import_from_statement) @import.statement

(call
  function: (_) @reference.call.target) @reference.call
