import {
  toGoogleRequest,
  fromGoogleResponse,
  transformGoogleStreamChunk as transformGoogleStreamChunkRaw,
} from '../google-adapter';

/**
 * Test helper: most tests below only care about the SSE chunk string produced
 * by the transform, not the signature side-channel. This wrapper keeps the
 * old string-returning shape so those tests don't need to destructure.
 */
function transformGoogleStreamChunk(chunk: string, model: string): string | null {
  return transformGoogleStreamChunkRaw(chunk, model).chunk;
}

describe('Google Adapter', () => {
  describe('toGoogleRequest', () => {
    it('converts basic messages', () => {
      const body = {
        messages: [{ role: 'user', content: 'Hello world' }],
      };
      const result = toGoogleRequest(body, 'gemini-2.0-flash');

      expect(result.contents).toEqual([{ role: 'user', parts: [{ text: 'Hello world' }] }]);
    });

    it('extracts system instruction', () => {
      const body = {
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'Hi' },
        ],
      };
      const result = toGoogleRequest(body, 'gemini-2.0-flash');

      expect(result.systemInstruction).toEqual({
        parts: [{ text: 'You are helpful.' }],
      });
      // System message should not appear in contents
      expect(result.contents).toEqual([{ role: 'user', parts: [{ text: 'Hi' }] }]);
    });

    it('maps assistant role to model', () => {
      const body = {
        messages: [
          { role: 'user', content: 'Hi' },
          { role: 'assistant', content: 'Hello!' },
        ],
      };
      const result = toGoogleRequest(body, 'gemini-2.0-flash');
      const contents = result.contents as Array<{ role: string }>;
      expect(contents[1].role).toBe('model');
    });

    it('maps generation config', () => {
      const body = {
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 1000,
        temperature: 0.7,
        top_p: 0.9,
      };
      const result = toGoogleRequest(body, 'gemini-2.0-flash');

      expect(result.generationConfig).toEqual({
        maxOutputTokens: 1000,
        temperature: 0.7,
        topP: 0.9,
      });
    });

    it('preserves native Google generationConfig params', () => {
      const body = {
        messages: [{ role: 'user', content: 'Hi' }],
        generationConfig: {
          topK: 40,
          thinkingConfig: {
            thinkingBudget: 128,
            includeThoughts: true,
          },
          responseMimeType: 'application/json',
        },
      };
      const result = toGoogleRequest(body, 'gemini-2.5-flash');

      expect(result.generationConfig).toEqual({
        topK: 40,
        thinkingConfig: {
          thinkingBudget: 128,
          includeThoughts: true,
        },
        responseMimeType: 'application/json',
      });
    });

    it('lets OpenAI-style generation aliases override native generationConfig fields', () => {
      const body = {
        messages: [{ role: 'user', content: 'Hi' }],
        generationConfig: {
          maxOutputTokens: 256,
          temperature: 0.2,
          topP: 0.4,
          thinkingConfig: {
            thinkingLevel: 'high',
          },
        },
        max_tokens: 1000,
        temperature: 0.7,
        top_p: 0.9,
      };
      const result = toGoogleRequest(body, 'gemini-3.5-flash');

      expect(result.generationConfig).toEqual({
        maxOutputTokens: 1000,
        temperature: 0.7,
        topP: 0.9,
        thinkingConfig: {
          thinkingLevel: 'high',
        },
      });
    });

    it('maps OpenAI json_schema response_format to sanitized Gemini response schema', () => {
      const body = {
        messages: [{ role: 'user', content: 'Return structured data' }],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'patient_summary',
            schema: {
              type: 'object',
              properties: {
                title: { type: 'string', default: 'ignored' },
                metadata: {
                  type: 'object',
                  properties: { source: { type: 'string' } },
                  additionalProperties: false,
                },
              },
              required: ['title'],
              additionalProperties: false,
              oneOf: [{ required: ['title'] }],
              $ref: '#/$defs/PatientSummary',
            },
          },
        },
      };
      const result = toGoogleRequest(body, 'gemini-2.0-flash');

      expect(result.generationConfig).toEqual({
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            metadata: {
              type: 'object',
              properties: { source: { type: 'string' } },
            },
          },
          required: ['title'],
        },
      });
    });

    it('maps OpenAI json_object response_format to Gemini JSON mime type only', () => {
      const body = {
        messages: [{ role: 'user', content: 'Return JSON' }],
        generationConfig: {
          responseSchema: { type: 'object', properties: { stale: { type: 'string' } } },
        },
        response_format: { type: 'json_object' },
      };
      const result = toGoogleRequest(body, 'gemini-2.0-flash');

      expect(result.generationConfig).toEqual({ responseMimeType: 'application/json' });
    });

    it('ignores unsupported OpenAI response_format types', () => {
      const body = {
        messages: [{ role: 'user', content: 'Return text' }],
        generationConfig: {
          temperature: 0.2,
          responseSchema: { type: 'object', properties: { kept: { type: 'string' } } },
        },
        response_format: { type: 'text' },
      };
      const result = toGoogleRequest(body, 'gemini-2.0-flash');

      expect(result.generationConfig).toEqual({
        temperature: 0.2,
        responseSchema: { type: 'object', properties: { kept: { type: 'string' } } },
      });
    });

    it('drops stale responseSchema when json_schema metadata is malformed', () => {
      const body = {
        messages: [{ role: 'user', content: 'Return structured data' }],
        generationConfig: {
          responseSchema: { type: 'object', properties: { stale: { type: 'string' } } },
        },
        response_format: { type: 'json_schema', json_schema: 'not-an-object' },
      };
      const result = toGoogleRequest(body, 'gemini-2.0-flash');

      expect(result.generationConfig).toEqual({ responseMimeType: 'application/json' });
    });

    it('drops stale responseSchema when json_schema response_format has no schema', () => {
      const body = {
        messages: [{ role: 'user', content: 'Return structured data' }],
        generationConfig: {
          responseSchema: { type: 'object', properties: { stale: { type: 'string' } } },
        },
        response_format: { type: 'json_schema', json_schema: { name: 'missing_schema' } },
      };
      const result = toGoogleRequest(body, 'gemini-2.0-flash');

      expect(result.generationConfig).toEqual({ responseMimeType: 'application/json' });
    });

    it('normalizes nullable JSON Schema type arrays for Gemini response schemas', () => {
      const body = {
        messages: [{ role: 'user', content: 'Return structured data' }],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'nullable_payload',
            schema: {
              type: 'object',
              properties: {
                title: { type: ['string', 'null'] },
                score: { type: ['number', 'null'] },
              },
            },
          },
        },
      };
      const result = toGoogleRequest(body, 'gemini-2.0-flash');

      expect(result.generationConfig).toEqual({
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', nullable: true },
            score: { type: 'number', nullable: true },
          },
        },
      });
    });

    it('converts tools to functionDeclarations', () => {
      const body = {
        messages: [{ role: 'user', content: 'Search for cats' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'web_search',
              description: 'Search the web',
              parameters: { type: 'object', properties: { query: { type: 'string' } } },
            },
          },
        ],
      };
      const result = toGoogleRequest(body, 'gemini-2.0-flash');

      expect(result.tools).toEqual([
        {
          functionDeclarations: [
            {
              name: 'web_search',
              description: 'Search the web',
              parameters: { type: 'object', properties: { query: { type: 'string' } } },
            },
          ],
        },
      ]);
    });

    it('strips unsupported JSON Schema fields from tool parameters', () => {
      const body = {
        messages: [{ role: 'user', content: 'Do something' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'my_tool',
              description: 'A tool',
              parameters: {
                type: 'object',
                properties: {
                  name: { type: 'string', title: 'Name', default: 'foo' },
                  count: { type: 'integer', minimum: 0, exclusiveMinimum: true },
                  config: {
                    type: 'object',
                    additionalProperties: true,
                    patternProperties: { '^x-': { type: 'string' } },
                    properties: { key: { type: 'string' } },
                  },
                },
                additionalProperties: false,
                $schema: 'http://json-schema.org/draft-07/schema#',
              },
            },
          },
        ],
      };
      const result = toGoogleRequest(body, 'gemini-2.0-flash');

      const tools = result.tools as Array<{
        functionDeclarations: Array<{ parameters: Record<string, unknown> }>;
      }>;
      const params = tools[0].functionDeclarations[0].parameters;

      // Top-level unsupported fields stripped
      expect(params).not.toHaveProperty('additionalProperties');
      expect(params).not.toHaveProperty('$schema');

      // Nested unsupported fields stripped
      const props = params.properties as Record<string, Record<string, unknown>>;
      expect(props.name).not.toHaveProperty('title');
      expect(props.name).not.toHaveProperty('default');
      expect(props.count).not.toHaveProperty('exclusiveMinimum');
      expect(props.config).not.toHaveProperty('additionalProperties');
      expect(props.config).not.toHaveProperty('patternProperties');

      // Supported fields preserved
      expect(params.type).toBe('object');
      expect(props.name.type).toBe('string');
      expect(props.count).toEqual({ type: 'integer', minimum: 0 });
      expect(props.config.type).toBe('object');
      expect(props.config.properties).toEqual({ key: { type: 'string' } });
    });

    it('strips additional Gemini-rejected JSON Schema keywords from tool parameters', () => {
      const body = {
        messages: [{ role: 'user', content: 'Validate config' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'validate_config',
              parameters: {
                type: 'object',
                propertyNames: { pattern: '^[a-z_]+$' },
                properties: {
                  tags: {
                    type: 'array',
                    items: { type: 'string' },
                    uniqueItems: true,
                    contains: { const: 'required' },
                    minContains: 1,
                    maxContains: 2,
                    prefixItems: [{ type: 'string' }],
                    additionalItems: false,
                  },
                  ratio: { type: 'number', multipleOf: 0.5 },
                  metadata: {
                    type: 'string',
                    readOnly: true,
                    writeOnly: false,
                    deprecated: true,
                    $comment: 'internal note',
                    $anchor: 'Metadata',
                    $dynamicRef: '#meta',
                    $dynamicAnchor: 'Meta',
                    $vocabulary: { 'https://json-schema.org/draft/2020-12/vocab/core': true },
                  },
                },
              },
            },
          },
        ],
      };
      const result = toGoogleRequest(body, 'gemini-3.1-pro-preview');

      const tools = result.tools as Array<{
        functionDeclarations: Array<{ parameters: Record<string, unknown> }>;
      }>;
      const params = tools[0].functionDeclarations[0].parameters;
      const props = params.properties as Record<string, Record<string, unknown>>;

      expect(params).not.toHaveProperty('propertyNames');
      expect(props.tags).toEqual({ type: 'array', items: { type: 'string' } });
      expect(props.ratio).toEqual({ type: 'number' });
      expect(props.metadata).toEqual({ type: 'string' });
    });

    it('strips exclusive numeric bounds without removing same-named properties', () => {
      const body = {
        messages: [{ role: 'user', content: 'Set limits' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'set_limits',
              parameters: {
                type: 'object',
                properties: {
                  threshold: {
                    type: 'number',
                    minimum: 0,
                    maximum: 1,
                    exclusiveMinimum: true,
                    exclusiveMaximum: false,
                  },
                  exclusiveMinimum: {
                    type: 'string',
                    description: 'A user-defined property name',
                  },
                },
              },
            },
          },
        ],
      };
      const result = toGoogleRequest(body, 'gemini-2.5-flash');

      const tools = result.tools as Array<{
        functionDeclarations: Array<{ parameters: Record<string, unknown> }>;
      }>;
      const props = tools[0].functionDeclarations[0].parameters.properties as Record<
        string,
        Record<string, unknown>
      >;

      expect(props.threshold).toEqual({ type: 'number', minimum: 0, maximum: 1 });
      expect(props.exclusiveMinimum).toEqual({
        type: 'string',
        description: 'A user-defined property name',
      });
    });

    it('strips both $ref and the non-standard dollar-less ref variant', () => {
      const body = {
        messages: [{ role: 'user', content: 'List cities' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'list_cities',
              parameters: {
                type: 'object',
                properties: {
                  cities: { type: 'array', items: { ref: '#/definitions/City' } },
                  neighbors: { type: 'array', items: { $ref: '#/definitions/City' } },
                },
              },
            },
          },
        ],
      };
      const result = toGoogleRequest(body, 'gemini-2.5-flash');

      const tools = result.tools as Array<{
        functionDeclarations: Array<{ parameters: Record<string, unknown> }>;
      }>;
      const props = tools[0].functionDeclarations[0].parameters.properties as Record<
        string,
        Record<string, { ref?: string; $ref?: string }>
      >;

      expect(props.cities.items).not.toHaveProperty('ref');
      expect(props.neighbors.items).not.toHaveProperty('$ref');
    });

    it('preserves a user property literally named "ref"', () => {
      const body = {
        messages: [{ role: 'user', content: 'lookup' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'lookup',
              parameters: {
                type: 'object',
                properties: { ref: { type: 'string', description: 'reference id' } },
              },
            },
          },
        ],
      };
      const result = toGoogleRequest(body, 'gemini-2.5-flash');

      const tools = result.tools as Array<{
        functionDeclarations: Array<{ parameters: Record<string, unknown> }>;
      }>;
      const props = tools[0].functionDeclarations[0].parameters.properties as Record<
        string,
        Record<string, unknown>
      >;

      expect(props).toHaveProperty('ref');
      expect(props.ref.type).toBe('string');
    });

    it('preserves property names that collide with unsupported schema keywords', () => {
      const body = {
        messages: [{ role: 'user', content: 'Do something' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'my_tool',
              description: 'A tool',
              parameters: {
                type: 'object',
                properties: {
                  title: { type: 'string' },
                  default: { type: 'number' },
                  examples: { type: 'array' },
                },
              },
            },
          },
        ],
      };
      const result = toGoogleRequest(body, 'gemini-2.0-flash');

      const tools = result.tools as Array<{
        functionDeclarations: Array<{ parameters: Record<string, unknown> }>;
      }>;
      const props = tools[0].functionDeclarations[0].parameters.properties as Record<
        string,
        Record<string, unknown>
      >;

      // Property names "title", "default", "examples" must be preserved
      expect(props).toHaveProperty('title');
      expect(props.title.type).toBe('string');
      expect(props).toHaveProperty('default');
      expect(props.default.type).toBe('number');
      expect(props).toHaveProperty('examples');
      expect(props.examples.type).toBe('array');
    });

    it('sanitizes array schemas inside tool parameters', () => {
      const body = {
        messages: [{ role: 'user', content: 'Do something' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'my_tool',
              description: 'A tool',
              parameters: {
                type: 'object',
                properties: {
                  tags: {
                    type: 'array',
                    items: { type: 'string', title: 'Tag Name', default: 'untitled' },
                  },
                },
                required: ['tags'],
              },
            },
          },
        ],
      };
      const result = toGoogleRequest(body, 'gemini-2.0-flash');

      const tools = result.tools as Array<{
        functionDeclarations: Array<{ parameters: Record<string, unknown> }>;
      }>;
      const params = tools[0].functionDeclarations[0].parameters;
      const props = params.properties as Record<string, Record<string, unknown>>;

      // Items should have unsupported fields stripped
      expect(props.tags.items).toEqual({ type: 'string' });
      // required array should pass through unchanged (primitive values)
      expect(params.required).toEqual(['tags']);
    });

    it('handles tools with no parameters', () => {
      const body = {
        messages: [{ role: 'user', content: 'Do something' }],
        tools: [
          {
            type: 'function',
            function: { name: 'no_params', description: 'No params tool' },
          },
        ],
      };
      const result = toGoogleRequest(body, 'gemini-2.0-flash');

      const tools = result.tools as Array<{
        functionDeclarations: Array<{ parameters?: unknown }>;
      }>;
      expect(tools[0].functionDeclarations[0].parameters).toBeUndefined();
    });

    describe('sanitizeSchema deep recursion and reference handling', () => {
      // Builds a `depth`-level nested object schema. Each level has a `child`
      // property whose schema carries an unsupported field set (title, default,
      // additionalProperties, $schema, $ref) plus a valid `type`. The innermost
      // leaf is a primitive string with the same unsupported set. Used to
      // verify recursive stripping fires at every layer with no early exit.
      function buildDeepSchema(depth: number): Record<string, unknown> {
        let leaf: Record<string, unknown> = {
          type: 'string',
          title: 'leaf-title',
          default: 'leaf-default',
          $schema: 'http://json-schema.org/draft-07/schema#',
          $ref: '#/definitions/Leaf',
        };
        for (let i = 0; i < depth; i++) {
          leaf = {
            type: 'object',
            title: `level-${i}-title`,
            default: { placeholder: true },
            additionalProperties: false,
            $ref: `#/definitions/Level${i}`,
            properties: { child: leaf },
          };
        }
        return leaf;
      }

      it('strips unsupported fields at every level of a 12-level nested schema', () => {
        const depth = 12;
        const body = {
          messages: [{ role: 'user', content: 'do' }],
          tools: [
            {
              type: 'function',
              function: { name: 'deep_tool', parameters: buildDeepSchema(depth) },
            },
          ],
        };

        const result = toGoogleRequest(body, 'gemini-2.0-flash');
        const tools = result.tools as Array<{
          functionDeclarations: Array<{ parameters: Record<string, unknown> }>;
        }>;
        let node: Record<string, unknown> | undefined = tools[0].functionDeclarations[0].parameters;

        for (let i = depth - 1; i >= 0; i--) {
          // The wrapping object at this level must keep `type` and `properties`
          // but all banned keywords must be gone.
          expect(node).toBeDefined();
          expect(node!.type).toBe('object');
          expect(node).not.toHaveProperty('title');
          expect(node).not.toHaveProperty('default');
          expect(node).not.toHaveProperty('additionalProperties');
          expect(node).not.toHaveProperty('$ref');
          const props = node!.properties as Record<string, Record<string, unknown>>;
          expect(props).toBeDefined();
          expect(props).toHaveProperty('child');
          node = props.child;
        }

        // The leaf is the original primitive level with its own unsupported set.
        expect(node).toBeDefined();
        expect(node!.type).toBe('string');
        expect(node).not.toHaveProperty('title');
        expect(node).not.toHaveProperty('default');
        expect(node).not.toHaveProperty('$schema');
        expect(node).not.toHaveProperty('$ref');
      });

      it('strips deeply nested allOf composition with nested additionalProperties', () => {
        // allOf carries object sub-schemas that themselves contain unsupported
        // keys. The whole allOf branch should be removed; the surviving fields
        // (properties, type) should sanitize cleanly without leaking allOf data.
        const body = {
          messages: [{ role: 'user', content: 'do' }],
          tools: [
            {
              type: 'function',
              function: {
                name: 'composed_tool',
                parameters: {
                  type: 'object',
                  allOf: [
                    {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        nested: {
                          type: 'object',
                          allOf: [{ type: 'object', additionalProperties: true }],
                          additionalProperties: { type: 'string' },
                          properties: { inner: { type: 'string', title: 'Inner' } },
                        },
                      },
                    },
                  ],
                  properties: {
                    keep: { type: 'string' },
                  },
                },
              },
            },
          ],
        };

        const result = toGoogleRequest(body, 'gemini-2.0-flash');
        const tools = result.tools as Array<{
          functionDeclarations: Array<{ parameters: Record<string, unknown> }>;
        }>;
        const params = tools[0].functionDeclarations[0].parameters;

        // allOf must be fully stripped — its contents do not survive.
        expect(params).not.toHaveProperty('allOf');
        // Surviving properties branch must still sanitize correctly.
        const props = params.properties as Record<string, Record<string, unknown>>;
        expect(props).toEqual({ keep: { type: 'string' } });
      });

      it('strips JSON Schema $ref that points to itself without infinite recursion', () => {
        // The standard JSON Schema way to express a self-cycle is a string
        // $ref pointing back to the root. Because `$ref` is in the unsupported
        // set, the key is removed and no recursion follows the pointer.
        const body = {
          messages: [{ role: 'user', content: 'do' }],
          tools: [
            {
              type: 'function',
              function: {
                name: 'self_ref',
                parameters: {
                  type: 'object',
                  $ref: '#',
                  properties: {
                    self: { $ref: '#' },
                    next: { type: 'object', $ref: '#/definitions/Node' },
                  },
                  definitions: {
                    Node: {
                      type: 'object',
                      properties: { next: { $ref: '#/definitions/Node' } },
                    },
                  },
                },
              },
            },
          ],
        };

        const result = toGoogleRequest(body, 'gemini-2.0-flash');
        const tools = result.tools as Array<{
          functionDeclarations: Array<{ parameters: Record<string, unknown> }>;
        }>;
        const params = tools[0].functionDeclarations[0].parameters;

        expect(params).not.toHaveProperty('$ref');
        // definitions is in the unsupported set and must be stripped wholesale.
        expect(params).not.toHaveProperty('definitions');
        const props = params.properties as Record<string, Record<string, unknown>>;
        expect(props).toHaveProperty('self');
        expect(props).toHaveProperty('next');
        // Per-property $ref keys must also be stripped at every level. The
        // surviving non-$ref keywords (like `type`) on each property survive.
        expect(props.self).not.toHaveProperty('$ref');
        expect(props.next).not.toHaveProperty('$ref');
        expect(props.next.type).toBe('object');
        // The `self` property had only $ref — after stripping, it sanitizes to
        // an empty object (no leftover keys), which is still a valid Gemini
        // sub-schema.
        expect(props.self).toEqual({});
      });

      it('strips $defs containing mutual $ref cycles without recursing through the cycle', () => {
        // $defs and definitions are both in the unsupported set. Mutual cycles
        // inside them never get walked because the parent key is removed before
        // recursion. This guards against future regressions that might allow
        // these keywords through (which would then re-enter the cycle forever).
        const body = {
          messages: [{ role: 'user', content: 'do' }],
          tools: [
            {
              type: 'function',
              function: {
                name: 'mutual_cycle',
                parameters: {
                  type: 'object',
                  $defs: {
                    A: { type: 'object', properties: { b: { $ref: '#/$defs/B' } } },
                    B: { type: 'object', properties: { a: { $ref: '#/$defs/A' } } },
                  },
                  properties: { kind: { type: 'string' } },
                },
              },
            },
          ],
        };

        const result = toGoogleRequest(body, 'gemini-2.0-flash');
        const tools = result.tools as Array<{
          functionDeclarations: Array<{ parameters: Record<string, unknown> }>;
        }>;
        const params = tools[0].functionDeclarations[0].parameters;
        expect(params).not.toHaveProperty('$defs');
        expect(params.properties).toEqual({ kind: { type: 'string' } });
      });

      it('strips a $ref chain that nests 15 levels deep without losing valid fields', () => {
        // Build a chain of objects where every level has both a $ref keyword
        // (to be stripped) and a `description` (to be kept). This verifies
        // recursion processes every layer rather than short-circuiting once
        // the first $ref is removed.
        const depth = 15;
        let chain: Record<string, unknown> = {
          type: 'object',
          description: 'leaf',
          $ref: '#/definitions/Leaf',
        };
        for (let i = 0; i < depth; i++) {
          chain = {
            type: 'object',
            description: `link-${i}`,
            $ref: `#/definitions/Link${i}`,
            properties: { next: chain },
          };
        }

        const body = {
          messages: [{ role: 'user', content: 'do' }],
          tools: [{ type: 'function', function: { name: 'chain_tool', parameters: chain } }],
        };

        const result = toGoogleRequest(body, 'gemini-2.0-flash');
        const tools = result.tools as Array<{
          functionDeclarations: Array<{ parameters: Record<string, unknown> }>;
        }>;
        let node: Record<string, unknown> | undefined = tools[0].functionDeclarations[0].parameters;
        for (let i = depth - 1; i >= 0; i--) {
          expect(node).toBeDefined();
          expect(node).not.toHaveProperty('$ref');
          expect(node!.description).toBe(`link-${i}`);
          node = (node!.properties as Record<string, Record<string, unknown>>).next;
        }
        // Leaf preserved with description intact and $ref gone.
        expect(node).toBeDefined();
        expect(node!.description).toBe('leaf');
        expect(node).not.toHaveProperty('$ref');
      });

      it('strips unsupported keywords inside arrays of sub-schemas at depth', () => {
        // Arrays of schemas (as you'd find in `prefixItems` or custom keyword
        // arrays the helper does not strip) still need to recurse so banned
        // keywords inside the items don't leak through.
        const body = {
          messages: [{ role: 'user', content: 'do' }],
          tools: [
            {
              type: 'function',
              function: {
                name: 'array_tool',
                parameters: {
                  type: 'object',
                  properties: {
                    rows: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          cells: {
                            type: 'array',
                            items: {
                              type: 'object',
                              additionalProperties: false,
                              $ref: '#/definitions/Cell',
                              properties: {
                                value: { type: 'string', title: 'v', default: '' },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          ],
        };

        const result = toGoogleRequest(body, 'gemini-2.0-flash');
        const tools = result.tools as Array<{
          functionDeclarations: Array<{ parameters: Record<string, unknown> }>;
        }>;
        const params = tools[0].functionDeclarations[0].parameters;
        const rows = (params.properties as Record<string, Record<string, unknown>>).rows;
        const cellItems = (
          (rows.items as Record<string, unknown>).properties as Record<
            string,
            Record<string, unknown>
          >
        ).cells.items as Record<string, unknown>;
        expect(cellItems).not.toHaveProperty('additionalProperties');
        expect(cellItems).not.toHaveProperty('$ref');
        const cellProps = cellItems.properties as Record<string, Record<string, unknown>>;
        expect(cellProps.value).toEqual({ type: 'string' });
      });
    });

    it('skips system messages with non-string content from systemInstruction', () => {
      const body = {
        messages: [
          { role: 'system', content: { instructions: 'Be helpful' } },
          { role: 'user', content: 'Hi' },
        ],
      };
      const result = toGoogleRequest(body, 'gemini-2.0-flash');

      // Non-string system content is filtered out (only string content makes it)
      expect(result.systemInstruction).toBeUndefined();
    });

    it('joins multiple system messages into one instruction', () => {
      const body = {
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'system', content: 'Be concise.' },
          { role: 'user', content: 'Hi' },
        ],
      };
      const result = toGoogleRequest(body, 'gemini-2.0-flash');

      const instruction = result.systemInstruction as { parts: Array<{ text: string }> };
      expect(instruction.parts[0].text).toContain('You are helpful.');
      expect(instruction.parts[0].text).toContain('Be concise.');
    });

    it('handles array content blocks in messages', () => {
      const body = {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'First part' },
              { type: 'text', text: 'Second part' },
              { type: 'image', source: { data: 'base64' } }, // non-text blocks are skipped
            ],
          },
        ],
      };
      const result = toGoogleRequest(body, 'gemini-2.0-flash');

      const contents = result.contents as Array<{ parts: Array<{ text?: string }> }>;
      expect(contents[0].parts).toHaveLength(2);
      expect(contents[0].parts[0].text).toBe('First part');
      expect(contents[0].parts[1].text).toBe('Second part');
    });

    it('maps OpenAI image_url data URLs to Gemini inlineData without decoding', () => {
      const body = {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What is this image?' },
              {
                type: 'image_url',
                image_url: {
                  url: 'data:image/png;name=chart.png;charset=utf-8;base64,iVBORw0KGgo=',
                },
              },
            ],
          },
        ],
      };
      const result = toGoogleRequest(body, 'gemini-2.0-flash');

      const contents = result.contents as Array<{ parts: Array<Record<string, unknown>> }>;
      expect(contents[0].parts).toEqual([
        { text: 'What is this image?' },
        { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } },
      ]);
    });

    it('maps Responses input_image data URLs to Gemini inlineData', () => {
      const body = {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'input_text', text: 'Describe it.' },
              { type: 'input_image', image_url: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==' },
            ],
          },
        ],
      };
      const result = toGoogleRequest(body, 'gemini-2.0-flash');

      const contents = result.contents as Array<{ parts: Array<Record<string, unknown>> }>;
      expect(contents[0].parts).toEqual([
        { text: 'Describe it.' },
        { inlineData: { mimeType: 'image/jpeg', data: '/9j/4AAQSkZJRg==' } },
      ]);
    });

    it('maps OpenAI image_url HTTP URLs to Gemini fileData', () => {
      const body = {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Describe it.' },
              {
                type: 'image_url',
                image_url: { url: 'https://example.test/image.webp' },
              },
            ],
          },
        ],
      };
      const result = toGoogleRequest(body, 'gemini-2.0-flash');

      const contents = result.contents as Array<{ parts: Array<Record<string, unknown>> }>;
      expect(contents[0].parts).toEqual([
        { text: 'Describe it.' },
        { fileData: { fileUri: 'https://example.test/image.webp' } },
      ]);
    });

    it('resolves functionResponse name from the assistant tool_calls history', () => {
      const body = {
        messages: [
          { role: 'user', content: 'Search for cats' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'web_search', arguments: '{"query":"cats"}' },
              },
            ],
          },
          {
            role: 'tool',
            tool_call_id: 'call_1',
            content: '{"results": ["cat1", "cat2"]}',
          },
        ],
      };
      const result = toGoogleRequest(body, 'gemini-2.0-flash');

      const contents = result.contents as Array<{
        role: string;
        parts: Array<Record<string, unknown>>;
      }>;
      const toolContent = contents[2];
      expect(toolContent.role).toBe('user');
      // `name` must be the real function name (resolved from the prior
      // assistant tool_calls), not the tool_call_id. `id` must mirror the
      // tool_call_id so Google can pair parallel calls with their responses.
      expect(toolContent.parts[0].functionResponse).toEqual({
        id: 'call_1',
        name: 'web_search',
        response: { result: '{"results": ["cat1", "cat2"]}' },
      });
    });

    it('falls back to unknown name when tool_call_id has no matching assistant call', () => {
      const body = {
        messages: [
          { role: 'user', content: 'Do something' },
          {
            role: 'tool',
            tool_call_id: 'call_orphan',
            content: '{"ok": true}',
          },
        ],
      };
      const result = toGoogleRequest(body, 'gemini-2.0-flash');

      const contents = result.contents as Array<{
        role: string;
        parts: Array<Record<string, unknown>>;
      }>;
      // The id is still preserved (so the functionResponse can be paired if
      // a later turn has the originating call), but the name degrades to the
      // explicit placeholder because we have no way to resolve it.
      expect(contents[1].parts[0].functionResponse).toEqual({
        id: 'call_orphan',
        name: 'unknown',
        response: { result: '{"ok": true}' },
      });
    });

    it('omits functionResponse.id when tool_call_id is missing entirely', () => {
      const body = {
        messages: [
          { role: 'user', content: 'Do something' },
          { role: 'tool', content: '{"ok": true}' },
        ],
      };
      const result = toGoogleRequest(body, 'gemini-2.0-flash');

      const contents = result.contents as Array<{
        role: string;
        parts: Array<Record<string, unknown>>;
      }>;
      expect(contents[1].parts[0].functionResponse).toEqual({
        name: 'unknown',
        response: { result: '{"ok": true}' },
      });
    });

    it('skips messages that produce no parts', () => {
      const body = {
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant' }, // no content, no tool_calls
          { role: 'user', content: 'Bye' },
        ],
      };
      const result = toGoogleRequest(body, 'gemini-2.0-flash');

      const contents = result.contents as Array<Record<string, unknown>>;
      // assistant with no parts should be skipped
      expect(contents).toHaveLength(2);
    });

    it('returns empty tools when tool has no function property', () => {
      const body = {
        messages: [{ role: 'user', content: 'Hi' }],
        tools: [{ type: 'retrieval' }], // no function property
      };
      const result = toGoogleRequest(body, 'gemini-2.0-flash');

      expect(result.tools).toBeUndefined();
    });

    it('omits generationConfig when no generation params', () => {
      const body = { messages: [{ role: 'user', content: 'Hi' }] };
      const result = toGoogleRequest(body, 'gemini-2.0-flash');

      expect(result.generationConfig).toBeUndefined();
    });

    it('handles tool_calls with empty arguments string in assistant messages', () => {
      const body = {
        messages: [
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'noop', arguments: '' },
              },
            ],
          },
        ],
      };
      const result = toGoogleRequest(body, 'gemini-2.0-flash');
      const contents = result.contents as Array<{ parts: Array<Record<string, unknown>> }>;
      expect(contents[0].parts[0].functionCall).toEqual({
        id: 'call_1',
        name: 'noop',
        args: {},
      });
    });

    it('handles tool_calls in assistant messages', () => {
      const body = {
        messages: [
          { role: 'user', content: 'Search for cats' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'web_search', arguments: '{"query":"cats"}' },
              },
            ],
          },
        ],
      };
      const result = toGoogleRequest(body, 'gemini-2.0-flash');
      const contents = result.contents as Array<{ parts: Array<Record<string, unknown>> }>;
      // The id is echoed back on the functionCall so Google can correlate
      // it with the functionResponse on the next turn (parallel tool calls).
      expect(contents[1].parts[0].functionCall).toEqual({
        id: 'call_1',
        name: 'web_search',
        args: { query: 'cats' },
      });
    });

    it('passes through thought_signature as Part-level thoughtSignature', () => {
      const body = {
        messages: [
          { role: 'user', content: 'Read my file' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
                thought_signature: 'sig_abc123',
              },
            ],
          },
        ],
      };
      const result = toGoogleRequest(body, 'gemini-3-pro-preview');
      const contents = result.contents as Array<{ parts: Array<Record<string, unknown>> }>;
      // The signature MUST be a sibling of functionCall on the Part, not
      // nested inside functionCall — Gemini 3 rejects the nested form.
      expect(contents[1].parts[0]).toEqual({
        functionCall: { id: 'call_1', name: 'read_file', args: { path: 'a.txt' } },
        thoughtSignature: 'sig_abc123',
      });
      expect(
        (contents[1].parts[0].functionCall as Record<string, unknown>).thoughtSignature,
      ).toBeUndefined();
    });

    it('re-injects cached signatures via signatureLookup', () => {
      const body = {
        messages: [
          { role: 'user', content: 'Read my file' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'read_file', arguments: '{}' },
              },
            ],
          },
        ],
      };
      const lookup = jest.fn().mockReturnValue('cached_sig');
      const result = toGoogleRequest(body, 'gemini-3-pro-preview', lookup);
      const contents = result.contents as Array<{ parts: Array<Record<string, unknown>> }>;
      expect(lookup).toHaveBeenCalledWith('call_1');
      expect(contents[1].parts[0].thoughtSignature).toBe('cached_sig');
    });

    it('prefers client-echoed signature over cache when both exist', () => {
      const body = {
        messages: [
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'noop', arguments: '{}' },
                thought_signature: 'from_client',
              },
            ],
          },
        ],
      };
      const lookup = jest.fn().mockReturnValue('from_cache');
      const result = toGoogleRequest(body, 'gemini-3-pro-preview', lookup);
      const contents = result.contents as Array<{ parts: Array<Record<string, unknown>> }>;
      expect(contents[0].parts[0].thoughtSignature).toBe('from_client');
    });

    it('falls back to cache when client echoes an empty string', () => {
      const body = {
        messages: [
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'noop', arguments: '{}' },
                thought_signature: '',
              },
            ],
          },
        ],
      };
      const lookup = jest.fn().mockReturnValue('cached_sig');
      const result = toGoogleRequest(body, 'gemini-3-pro-preview', lookup);
      const contents = result.contents as Array<{ parts: Array<Record<string, unknown>> }>;
      expect(contents[0].parts[0].thoughtSignature).toBe('cached_sig');
    });

    it('injects a dummy thoughtSignature when neither client nor cache provides one', () => {
      const body = {
        messages: [
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'noop', arguments: '{}' },
              },
            ],
          },
        ],
      };
      const result = toGoogleRequest(body, 'gemini-2.0-flash');
      const contents = result.contents as Array<{ parts: Array<Record<string, unknown>> }>;
      expect(contents[0].parts[0]).toEqual({
        functionCall: { id: 'call_1', name: 'noop', args: {} },
        thoughtSignature: 'context_engineering_is_the_way_to_go',
      });
    });
  });

  describe('fromGoogleResponse', () => {
    it('converts basic text response', () => {
      const google = {
        candidates: [
          {
            content: { parts: [{ text: 'Hello!' }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 5,
          totalTokenCount: 15,
        },
      };

      const result = fromGoogleResponse(google, 'gemini-2.0-flash');

      expect(result.object).toBe('chat.completion');
      expect(result.model).toBe('gemini-2.0-flash');

      const choices = result.choices as Array<{
        message: Record<string, unknown>;
        finish_reason: string;
      }>;
      expect(choices).toHaveLength(1);
      expect(choices[0].message.role).toBe('assistant');
      expect(choices[0].message.content).toBe('Hello!');
      expect(choices[0].finish_reason).toBe('stop');

      const usage = result.usage as Record<string, number>;
      expect(usage.prompt_tokens).toBe(10);
      expect(usage.completion_tokens).toBe(5);
    });

    it('extracts cachedContentTokenCount from usage', () => {
      const google = {
        candidates: [
          {
            content: { parts: [{ text: 'Hello!' }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: 100,
          candidatesTokenCount: 50,
          totalTokenCount: 150,
          cachedContentTokenCount: 80,
        },
      };

      const result = fromGoogleResponse(google, 'gemini-2.0-flash');
      const usage = result.usage as Record<string, unknown>;
      expect(usage.cache_read_tokens).toBe(80);
      expect(usage.prompt_tokens).toBe(100);

      const details = usage.prompt_tokens_details as { cached_tokens: number };
      expect(details.cached_tokens).toBe(80);
    });

    it('defaults cachedContentTokenCount to 0 when absent', () => {
      const google = {
        candidates: [
          {
            content: { parts: [{ text: 'Hello!' }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 5,
          totalTokenCount: 15,
        },
      };

      const result = fromGoogleResponse(google, 'gemini-2.0-flash');
      const usage = result.usage as Record<string, unknown>;
      expect(usage.cache_read_tokens).toBe(0);

      const details = usage.prompt_tokens_details as { cached_tokens: number };
      expect(details.cached_tokens).toBe(0);
    });

    it('includes prompt_tokens_details with large cached token counts', () => {
      const google = {
        candidates: [
          {
            content: { parts: [{ text: 'Hello!' }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: 50000,
          candidatesTokenCount: 1000,
          totalTokenCount: 51000,
          cachedContentTokenCount: 45000,
        },
      };

      const result = fromGoogleResponse(google, 'gemini-2.0-flash');
      const usage = result.usage as Record<string, unknown>;
      expect(usage.cache_read_tokens).toBe(45000);
      expect(usage.prompt_tokens).toBe(50000);
      expect(usage.total_tokens).toBe(51000);

      const details = usage.prompt_tokens_details as { cached_tokens: number };
      expect(details.cached_tokens).toBe(45000);
    });

    it('handles function call response', () => {
      const google = {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: { name: 'search', args: { query: 'cats' } },
                },
              ],
            },
            finishReason: 'STOP',
          },
        ],
      };

      const result = fromGoogleResponse(google, 'gemini-2.0-flash');
      const choices = result.choices as Array<{ message: Record<string, unknown> }>;
      const toolCalls = choices[0].message.tool_calls as Array<Record<string, unknown>>;
      expect(toolCalls).toHaveLength(1);

      const fn = toolCalls[0].function as { name: string; arguments: string };
      expect(fn.name).toBe('search');
      expect(JSON.parse(fn.arguments)).toEqual({ query: 'cats' });
    });

    it('handles empty candidates', () => {
      const result = fromGoogleResponse({ candidates: [] }, 'gemini-2.0-flash');
      const choices = result.choices as unknown[];
      expect(choices).toHaveLength(0);
    });

    it('maps SAFETY finish reason to content_filter', () => {
      const google = {
        candidates: [
          {
            content: { parts: [{ text: '' }] },
            finishReason: 'SAFETY',
          },
        ],
      };
      const result = fromGoogleResponse(google, 'gemini-2.0-flash');
      const choices = result.choices as Array<{ finish_reason: string }>;
      expect(choices[0].finish_reason).toBe('content_filter');
    });

    it('maps RECITATION finish reason to content_filter', () => {
      const google = {
        candidates: [
          {
            content: { parts: [{ text: '' }] },
            finishReason: 'RECITATION',
          },
        ],
      };
      const result = fromGoogleResponse(google, 'gemini-2.0-flash');
      const choices = result.choices as Array<{ finish_reason: string }>;
      expect(choices[0].finish_reason).toBe('content_filter');
    });

    it('maps unknown finish reason to stop', () => {
      const google = {
        candidates: [
          {
            content: { parts: [{ text: 'ok' }] },
            finishReason: 'UNKNOWN_REASON',
          },
        ],
      };
      const result = fromGoogleResponse(google, 'gemini-2.0-flash');
      const choices = result.choices as Array<{ finish_reason: string }>;
      expect(choices[0].finish_reason).toBe('stop');
    });

    it('handles missing finishReason as stop', () => {
      const google = {
        candidates: [
          {
            content: { parts: [{ text: 'ok' }] },
          },
        ],
      };
      const result = fromGoogleResponse(google, 'gemini-2.0-flash');
      const choices = result.choices as Array<{ finish_reason: string }>;
      expect(choices[0].finish_reason).toBe('stop');
    });

    it('omits usage when usageMetadata is absent', () => {
      const google = {
        candidates: [
          {
            content: { parts: [{ text: 'hi' }] },
            finishReason: 'STOP',
          },
        ],
      };
      const result = fromGoogleResponse(google, 'gemini-2.0-flash');
      expect(result.usage).toBeUndefined();
    });

    it('handles no candidates', () => {
      const result = fromGoogleResponse({}, 'gemini-2.0-flash');
      const choices = result.choices as unknown[];
      expect(choices).toHaveLength(0);
    });

    it('returns null content when parts have no text', () => {
      const google = {
        candidates: [
          {
            content: { parts: [{ functionCall: { name: 'test', args: {} } }] },
            finishReason: 'STOP',
          },
        ],
      };
      const result = fromGoogleResponse(google, 'gemini-2.0-flash');
      const choices = result.choices as Array<{ message: Record<string, unknown> }>;
      expect(choices[0].message.content).toBeNull();
    });

    it('maps STOP finish reason to tool_calls when tool calls present', () => {
      const google = {
        candidates: [
          {
            content: {
              parts: [{ functionCall: { name: 'search', args: { query: 'cats' } } }],
            },
            finishReason: 'STOP',
          },
        ],
      };
      const result = fromGoogleResponse(google, 'gemini-2.0-flash');
      const choices = result.choices as Array<{ finish_reason: string }>;
      expect(choices[0].finish_reason).toBe('tool_calls');
    });

    it('maps MAX_TOKENS finish reason to length', () => {
      const google = {
        candidates: [
          {
            content: { parts: [{ text: 'truncated' }] },
            finishReason: 'MAX_TOKENS',
          },
        ],
      };

      const result = fromGoogleResponse(google, 'gemini-2.0-flash');
      const choices = result.choices as Array<{ finish_reason: string }>;
      expect(choices[0].finish_reason).toBe('length');
    });

    it('maps MAX_TOKENS to length even when tool calls are present', () => {
      const google = {
        candidates: [
          {
            content: {
              parts: [{ functionCall: { name: 'search', args: { q: 'test' } } }],
            },
            finishReason: 'MAX_TOKENS',
          },
        ],
      };
      const result = fromGoogleResponse(google, 'gemini-2.0-flash');
      const choices = result.choices as Array<{ finish_reason: string }>;
      // MAX_TOKENS always maps to 'length' regardless of tool calls
      expect(choices[0].finish_reason).toBe('length');
    });

    it('maps missing finishReason to tool_calls when tool calls present', () => {
      const google = {
        candidates: [
          {
            content: {
              parts: [{ functionCall: { name: 'get_weather', args: { city: 'NYC' } } }],
            },
          },
        ],
      };
      const result = fromGoogleResponse(google, 'gemini-2.0-flash');
      const choices = result.choices as Array<{ finish_reason: string }>;
      expect(choices[0].finish_reason).toBe('tool_calls');
    });

    it('handles candidate with missing content property', () => {
      const google = {
        candidates: [{ finishReason: 'STOP' }],
      };
      const result = fromGoogleResponse(google, 'gemini-2.0-flash');
      const choices = result.choices as Array<{
        message: Record<string, unknown>;
        finish_reason: string;
      }>;
      expect(choices[0].message.content).toBeNull();
      expect(choices[0].finish_reason).toBe('stop');
    });

    it('handles usageMetadata with missing individual fields', () => {
      const google = {
        candidates: [
          {
            content: { parts: [{ text: 'ok' }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {},
      };
      const result = fromGoogleResponse(google, 'gemini-2.0-flash');
      const usage = result.usage as Record<string, unknown>;
      expect(usage.prompt_tokens).toBe(0);
      expect(usage.completion_tokens).toBe(0);
      expect(usage.total_tokens).toBe(0);
      expect(usage.cache_read_tokens).toBe(0);
    });

    it('extracts Part-level thoughtSignature from functionCall response', () => {
      const google = {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: { name: 'read_file', args: { path: 'a.txt' } },
                  thoughtSignature: 'sig_xyz789',
                },
              ],
            },
            finishReason: 'STOP',
          },
        ],
      };

      const result = fromGoogleResponse(google, 'gemini-3-pro-preview');
      const choices = result.choices as Array<{ message: Record<string, unknown> }>;
      const toolCalls = choices[0].message.tool_calls as Array<Record<string, unknown>>;
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0].thought_signature).toBe('sig_xyz789');

      // The extracted signature is also surfaced via _extractedSignatures so
      // the response handler can cache it for the next turn.
      const extracted = (result as Record<string, unknown>)._extractedSignatures as Array<{
        toolCallId: string;
        signature: string;
      }>;
      expect(extracted).toHaveLength(1);
      expect(extracted[0].signature).toBe('sig_xyz789');
      expect(extracted[0].toolCallId).toBe(toolCalls[0].id);
    });

    it('drops thought text parts from assistant content', () => {
      const google = {
        candidates: [
          {
            content: {
              parts: [
                { text: 'Internal reasoning...', thought: true },
                { text: 'User-facing answer.' },
              ],
            },
            finishReason: 'STOP',
          },
        ],
      };
      const result = fromGoogleResponse(google, 'gemini-3-pro-preview');
      const choices = result.choices as Array<{ message: Record<string, unknown> }>;
      expect(choices[0].message.content).toBe('User-facing answer.');
    });

    it('omits thought_signature when the Part has no signature', () => {
      const google = {
        candidates: [
          {
            content: {
              parts: [{ functionCall: { name: 'search', args: { q: 'cats' } } }],
            },
            finishReason: 'STOP',
          },
        ],
      };

      const result = fromGoogleResponse(google, 'gemini-2.0-flash');
      const choices = result.choices as Array<{ message: Record<string, unknown> }>;
      const toolCalls = choices[0].message.tool_calls as Array<Record<string, unknown>>;
      expect(toolCalls[0].thought_signature).toBeUndefined();
    });

    it('handles multiple function calls in response', () => {
      const google = {
        candidates: [
          {
            content: {
              parts: [
                { functionCall: { name: 'search', args: { q: 'cats' } } },
                { functionCall: { name: 'search', args: { q: 'dogs' } } },
              ],
            },
            finishReason: 'STOP',
          },
        ],
      };
      const result = fromGoogleResponse(google, 'gemini-2.0-flash');
      const choices = result.choices as Array<{
        message: Record<string, unknown>;
        finish_reason: string;
      }>;
      const toolCalls = choices[0].message.tool_calls as Array<Record<string, unknown>>;
      expect(toolCalls).toHaveLength(2);
      expect(choices[0].finish_reason).toBe('tool_calls');
    });
  });

  describe('transformGoogleStreamChunk', () => {
    it('converts a text chunk to OpenAI SSE format', () => {
      const chunk = JSON.stringify({
        candidates: [
          {
            content: { parts: [{ text: 'Hi' }] },
          },
        ],
      });

      const result = transformGoogleStreamChunk(chunk, 'gemini-2.0-flash');
      expect(result).toContain('data: ');
      expect(result).toContain('"chat.completion.chunk"');

      const data = JSON.parse(result!.replace('data: ', '').trim());
      expect(data.choices[0].delta.content).toBe('Hi');
    });

    it('returns null for empty chunks', () => {
      expect(transformGoogleStreamChunk('', 'gemini-2.0-flash')).toBeNull();
      expect(transformGoogleStreamChunk('  ', 'gemini-2.0-flash')).toBeNull();
    });

    it('returns null for invalid JSON', () => {
      expect(transformGoogleStreamChunk('not json', 'gemini-2.0-flash')).toBeNull();
    });

    it('returns null for chunks without text', () => {
      const chunk = JSON.stringify({ candidates: [{ content: { parts: [] } }] });
      expect(transformGoogleStreamChunk(chunk, 'gemini-2.0-flash')).toBeNull();
    });

    it('emits usage event when usageMetadata is present', () => {
      const chunk = JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 150 },
      });
      const result = transformGoogleStreamChunk(chunk, 'gemini-2.0-flash');
      expect(result).toContain('"content":"done"');
      expect(result).toContain('"prompt_tokens":100');
      expect(result).toContain('"completion_tokens":50');
      expect(result).toContain('"finish_reason":"stop"');
    });

    it('emits usage-only event when no text but usageMetadata exists', () => {
      const chunk = JSON.stringify({
        candidates: [{ content: { parts: [] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 80, totalTokenCount: 280 },
      });
      const result = transformGoogleStreamChunk(chunk, 'gemini-2.0-flash');
      expect(result).not.toBeNull();
      expect(result).toContain('"prompt_tokens":200');
      expect(result).toContain('"completion_tokens":80');
    });

    it('returns null when no candidates and no usageMetadata', () => {
      const chunk = JSON.stringify({ candidates: [] });
      expect(transformGoogleStreamChunk(chunk, 'gemini-2.0-flash')).toBeNull();
    });

    it('defaults missing token counts to 0 in usage', () => {
      const chunk = JSON.stringify({
        candidates: [{ content: { parts: [] }, finishReason: 'STOP' }],
        usageMetadata: {},
      });
      const result = transformGoogleStreamChunk(chunk, 'gemini-2.0-flash');
      expect(result).toContain('"prompt_tokens":0');
      expect(result).toContain('"completion_tokens":0');
      expect(result).toContain('"total_tokens":0');
    });

    it('emits tool call delta for functionCall parts', () => {
      const chunk = JSON.stringify({
        candidates: [
          { content: { parts: [{ functionCall: { name: 'fn', args: { q: 'test' } } }] } },
        ],
      });
      const result = transformGoogleStreamChunk(chunk, 'gemini-2.0-flash');
      expect(result).not.toBeNull();
      const data = JSON.parse(result!.split('\n\n')[0].replace('data: ', ''));
      expect(data.choices[0].delta.tool_calls).toHaveLength(1);
      expect(data.choices[0].delta.tool_calls[0].type).toBe('function');
      expect(data.choices[0].delta.tool_calls[0].function.name).toBe('fn');
      expect(JSON.parse(data.choices[0].delta.tool_calls[0].function.arguments)).toEqual({
        q: 'test',
      });
    });

    it('emits tool call and text together when both present', () => {
      const chunk = JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                { text: 'Let me call a tool.' },
                { functionCall: { name: 'search', args: { query: 'cats' } } },
              ],
            },
          },
        ],
      });
      const result = transformGoogleStreamChunk(chunk, 'gemini-2.0-flash');
      expect(result).not.toBeNull();
      const data = JSON.parse(result!.split('\n\n')[0].replace('data: ', ''));
      expect(data.choices[0].delta.content).toBe('Let me call a tool.');
      expect(data.choices[0].delta.tool_calls).toHaveLength(1);
      expect(data.choices[0].delta.tool_calls[0].function.name).toBe('search');
    });

    it('emits finish_reason tool_calls when functionCall with usage', () => {
      const chunk = JSON.stringify({
        candidates: [
          {
            content: { parts: [{ functionCall: { name: 'fn', args: {} } }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
      });
      const result = transformGoogleStreamChunk(chunk, 'gemini-2.0-flash');
      expect(result).toContain('"finish_reason":"tool_calls"');
    });

    it('handles multiple functionCall parts with sequential indices', () => {
      const chunk = JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                { functionCall: { name: 'tool_a', args: { x: 1 } } },
                { functionCall: { name: 'tool_b', args: { y: 2 } } },
              ],
            },
          },
        ],
      });
      const result = transformGoogleStreamChunk(chunk, 'gemini-2.0-flash');
      const data = JSON.parse(result!.split('\n\n')[0].replace('data: ', ''));
      expect(data.choices[0].delta.tool_calls).toHaveLength(2);
      expect(data.choices[0].delta.tool_calls[0].index).toBe(0);
      expect(data.choices[0].delta.tool_calls[0].function.name).toBe('tool_a');
      expect(data.choices[0].delta.tool_calls[1].index).toBe(1);
      expect(data.choices[0].delta.tool_calls[1].function.name).toBe('tool_b');
    });

    it('preserves Part-level thoughtSignature on streaming functionCall', () => {
      const chunk = JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: { name: 'read_file', args: { path: 'a.txt' } },
                  thoughtSignature: 'sig_stream_456',
                },
              ],
            },
          },
        ],
      });
      const { chunk: result, signatures } = transformGoogleStreamChunkRaw(
        chunk,
        'gemini-3-pro-preview',
      );
      const data = JSON.parse(result!.split('\n\n')[0].replace('data: ', ''));
      expect(data.choices[0].delta.tool_calls[0].thought_signature).toBe('sig_stream_456');
      expect(signatures).toHaveLength(1);
      expect(signatures[0].signature).toBe('sig_stream_456');
      expect(signatures[0].toolCallId).toBe(data.choices[0].delta.tool_calls[0].id);
    });

    it('returns empty signatures array when stream chunk has no thoughtSignature', () => {
      const chunk = JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'hi' }] } }],
      });
      const { signatures } = transformGoogleStreamChunkRaw(chunk, 'gemini-2.0-flash');
      expect(signatures).toEqual([]);
    });

    it('drops thought text parts from streaming content', () => {
      const chunk = JSON.stringify({
        candidates: [
          {
            content: {
              parts: [{ text: 'thinking', thought: true }, { text: 'answer' }],
            },
          },
        ],
      });
      const result = transformGoogleStreamChunk(chunk, 'gemini-3-pro-preview');
      const data = JSON.parse(result!.split('\n\n')[0].replace('data: ', ''));
      expect(data.choices[0].delta.content).toBe('answer');
    });

    it('handles functionCall with null args', () => {
      const chunk = JSON.stringify({
        candidates: [{ content: { parts: [{ functionCall: { name: 'noop', args: null } }] } }],
      });
      const result = transformGoogleStreamChunk(chunk, 'gemini-2.0-flash');
      const data = JSON.parse(result!.split('\n\n')[0].replace('data: ', ''));
      expect(JSON.parse(data.choices[0].delta.tool_calls[0].function.arguments)).toEqual({});
    });

    it('handles functionCall with undefined args in stream', () => {
      const chunk = JSON.stringify({
        candidates: [{ content: { parts: [{ functionCall: { name: 'noop' } }] } }],
      });
      const result = transformGoogleStreamChunk(chunk, 'gemini-2.0-flash');
      const data = JSON.parse(result!.split('\n\n')[0].replace('data: ', ''));
      expect(JSON.parse(data.choices[0].delta.tool_calls[0].function.arguments)).toEqual({});
    });

    it('includes cachedContentTokenCount in stream usage', () => {
      const chunk = JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }],
        usageMetadata: {
          promptTokenCount: 100,
          candidatesTokenCount: 50,
          totalTokenCount: 150,
          cachedContentTokenCount: 80,
        },
      });
      const result = transformGoogleStreamChunk(chunk, 'gemini-2.0-flash');
      expect(result).toContain('"cache_read_tokens":80');
      expect(result).toContain('"cached_tokens":80');
    });

    it('emits finish_reason stop for STOP without tool calls in stream with usage', () => {
      const chunk = JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
      });
      const result = transformGoogleStreamChunk(chunk, 'gemini-2.0-flash');
      const parts = result!.split('\n\n').filter(Boolean);
      // The finish chunk (second part) should have finish_reason 'stop'
      const finishChunk = JSON.parse(parts[1].replace('data: ', ''));
      expect(finishChunk.choices[0].finish_reason).toBe('stop');
    });

    it('emits usage when candidates field is missing', () => {
      const chunk = JSON.stringify({
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
      });
      const result = transformGoogleStreamChunk(chunk, 'gemini-2.0-flash');
      expect(result).toContain('"prompt_tokens":10');
      expect(result).toContain('"finish_reason":"stop"');
    });
  });

  describe('functionCall id round-trip (Fix 1)', () => {
    describe('fromGoogleResponse', () => {
      it("preserves Google's own functionCall id instead of generating a synthetic one", () => {
        const google = {
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: {
                      id: '4z1aadbn',
                      name: 'search',
                      args: { query: 'cats' },
                    },
                  },
                ],
              },
              finishReason: 'STOP',
            },
          ],
        };

        const result = fromGoogleResponse(google, 'gemini-2.0-flash');
        const choices = result.choices as Array<{ message: Record<string, unknown> }>;
        const toolCalls = choices[0].message.tool_calls as Array<Record<string, unknown>>;
        expect(toolCalls).toHaveLength(1);
        // The id MUST equal Google's own id, not a synthetic `call_<uuid>`.
        expect(toolCalls[0].id).toBe('4z1aadbn');
        expect(toolCalls[0].id).not.toMatch(/^call_/);
      });

      it('round-trips Google id alongside Part-level thoughtSignature via _extractedSignatures', () => {
        const google = {
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: {
                      id: '4z1aadbn',
                      name: 'read_file',
                      args: { path: 'a.txt' },
                    },
                    thoughtSignature: 'sig_abc',
                  },
                ],
              },
              finishReason: 'STOP',
            },
          ],
        };

        const result = fromGoogleResponse(google, 'gemini-3-pro-preview');
        const choices = result.choices as Array<{ message: Record<string, unknown> }>;
        const toolCalls = choices[0].message.tool_calls as Array<Record<string, unknown>>;
        expect(toolCalls[0].id).toBe('4z1aadbn');

        const extracted = (result as Record<string, unknown>)._extractedSignatures as Array<{
          toolCallId: string;
          signature: string;
        }>;
        expect(extracted).toHaveLength(1);
        // The extracted signature entry is keyed by Google's own id — not a
        // synthetic uuid — so the cache re-injection path can look it up later.
        expect(extracted[0].toolCallId).toBe('4z1aadbn');
        expect(extracted[0].signature).toBe('sig_abc');
      });

      it('falls back to a synthetic call_<uuid> when functionCall has no id', () => {
        const google = {
          candidates: [
            {
              content: {
                parts: [{ functionCall: { name: 'noop', args: {} } }],
              },
              finishReason: 'STOP',
            },
          ],
        };
        const result = fromGoogleResponse(google, 'gemini-2.0-flash');
        const choices = result.choices as Array<{ message: Record<string, unknown> }>;
        const toolCalls = choices[0].message.tool_calls as Array<Record<string, unknown>>;
        expect(toolCalls[0].id).toMatch(/^call_/);
      });

      it('preserves distinct ids for multiple functionCall parts', () => {
        const google = {
          candidates: [
            {
              content: {
                parts: [
                  { functionCall: { id: 'g_1', name: 'search', args: { q: 'cats' } } },
                  { functionCall: { id: 'g_2', name: 'search', args: { q: 'dogs' } } },
                ],
              },
              finishReason: 'STOP',
            },
          ],
        };
        const result = fromGoogleResponse(google, 'gemini-2.0-flash');
        const choices = result.choices as Array<{ message: Record<string, unknown> }>;
        const toolCalls = choices[0].message.tool_calls as Array<Record<string, unknown>>;
        expect(toolCalls).toHaveLength(2);
        expect(toolCalls[0].id).toBe('g_1');
        expect(toolCalls[1].id).toBe('g_2');
      });
    });

    describe('transformGoogleStreamChunk', () => {
      it("preserves Google's own functionCall id on streaming chunks", () => {
        const chunk = JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: { id: '4z1aadbn', name: 'search', args: { query: 'cats' } },
                  },
                ],
              },
            },
          ],
        });
        const result = transformGoogleStreamChunk(chunk, 'gemini-2.0-flash');
        const data = JSON.parse(result!.split('\n\n')[0].replace('data: ', ''));
        expect(data.choices[0].delta.tool_calls[0].id).toBe('4z1aadbn');
      });

      it('falls back to call_<uuid> on stream when functionCall has no id', () => {
        const chunk = JSON.stringify({
          candidates: [
            {
              content: { parts: [{ functionCall: { name: 'noop', args: {} } }] },
            },
          ],
        });
        const result = transformGoogleStreamChunk(chunk, 'gemini-2.0-flash');
        const data = JSON.parse(result!.split('\n\n')[0].replace('data: ', ''));
        expect(data.choices[0].delta.tool_calls[0].id).toMatch(/^call_/);
      });

      it('preserves distinct ids across multiple functionCall parts on stream', () => {
        const chunk = JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  { functionCall: { id: 's_1', name: 'tool_a', args: { x: 1 } } },
                  { functionCall: { id: 's_2', name: 'tool_b', args: { y: 2 } } },
                ],
              },
            },
          ],
        });
        const result = transformGoogleStreamChunk(chunk, 'gemini-2.0-flash');
        const data = JSON.parse(result!.split('\n\n')[0].replace('data: ', ''));
        expect(data.choices[0].delta.tool_calls).toHaveLength(2);
        expect(data.choices[0].delta.tool_calls[0].id).toBe('s_1');
        expect(data.choices[0].delta.tool_calls[1].id).toBe('s_2');
      });
    });
  });

  describe('buildToolCallNameMap via toGoogleRequest (Fix 2)', () => {
    it('resolves parallel tool responses in reversed order by id', () => {
      const body = {
        messages: [
          { role: 'user', content: 'Do things' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'weather', arguments: '{"city":"NYC"}' },
              },
              {
                id: 'call_2',
                type: 'function',
                function: { name: 'search', arguments: '{"q":"cats"}' },
              },
            ],
          },
          // Responses intentionally arrive in reversed order: call_2 first, then call_1.
          { role: 'tool', tool_call_id: 'call_2', content: '{"results":[]}' },
          { role: 'tool', tool_call_id: 'call_1', content: '{"temp":72}' },
        ],
      };
      const result = toGoogleRequest(body, 'gemini-2.0-flash');
      const contents = result.contents as Array<{
        role: string;
        parts: Array<Record<string, unknown>>;
      }>;

      // The assistant entry has two functionCall parts with ids echoed.
      const assistantParts = contents[1].parts;
      expect(assistantParts).toHaveLength(2);
      expect(assistantParts[0].functionCall).toEqual({
        id: 'call_1',
        name: 'weather',
        args: { city: 'NYC' },
      });
      expect(assistantParts[1].functionCall).toEqual({
        id: 'call_2',
        name: 'search',
        args: { q: 'cats' },
      });

      // call_2 and call_1 responses are merged into a single user turn with
      // both functionResponse parts — Gemini requires N functionCall parts to be
      // answered by exactly N functionResponse parts in one user turn.
      expect(contents).toHaveLength(3);
      expect(contents[2].role).toBe('user');
      expect(contents[2].parts).toHaveLength(2);
      expect(contents[2].parts[0].functionResponse).toEqual({
        id: 'call_2',
        name: 'search',
        response: { result: '{"results":[]}' },
      });
      expect(contents[2].parts[1].functionResponse).toEqual({
        id: 'call_1',
        name: 'weather',
        response: { result: '{"temp":72}' },
      });
    });

    it('returns empty args when tool_call arguments string is invalid JSON', () => {
      const body = {
        messages: [
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'noop', arguments: 'not-valid-json{' },
              },
            ],
          },
        ],
      };
      const result = toGoogleRequest(body, 'gemini-2.0-flash');
      const contents = result.contents as Array<{ parts: Array<Record<string, unknown>> }>;
      // safeParseArgs catches and returns {}.
      expect(contents[0].parts[0].functionCall).toEqual({
        id: 'call_1',
        name: 'noop',
        args: {},
      });
    });

    it('resolves each tool_call_id to the correct function name when multiple distinct tools are used', () => {
      const body = {
        messages: [
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_a',
                type: 'function',
                function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'call_a', content: 'contents of a' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_b',
                type: 'function',
                function: { name: 'write_file', arguments: '{"path":"b.txt"}' },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'call_b', content: 'ok' },
        ],
      };
      const result = toGoogleRequest(body, 'gemini-2.0-flash');
      const contents = result.contents as Array<{
        role: string;
        parts: Array<Record<string, unknown>>;
      }>;

      // First tool response resolves to read_file.
      expect(contents[1].parts[0].functionResponse).toEqual({
        id: 'call_a',
        name: 'read_file',
        response: { result: 'contents of a' },
      });
      // Second tool response resolves to write_file — id correctly keys into
      // the name map that was built from BOTH assistant messages.
      expect(contents[3].parts[0].functionResponse).toEqual({
        id: 'call_b',
        name: 'write_file',
        response: { result: 'ok' },
      });
    });
  });
});
