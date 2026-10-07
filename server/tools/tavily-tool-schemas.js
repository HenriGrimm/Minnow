export const MAP_PROPERTIES = {
  url: { type: 'string', description: 'Public HTTP(S) URL to begin mapping.' },
  instructions: { type: 'string', description: 'Optional discovery guidance. Doubles mapping credit cost.' },
  max_depth: { type: 'integer', minimum: 1, maximum: 5, description: 'Link depth; default 1.' },
  max_breadth: { type: 'integer', minimum: 1, maximum: 100, description: 'Links followed per page; default 20.' },
  limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Maximum links processed; default 50. Results are not necessarily a complete sitemap.' },
  select_paths: { type: 'array', items: { type: 'string' }, maxItems: 20, description: 'Include URL paths matching these regex patterns, e.g. /docs/.*.' },
  exclude_paths: { type: 'array', items: { type: 'string' }, maxItems: 20, description: 'Exclude URL paths matching these regex patterns.' },
  allow_external: { type: 'boolean', description: 'Include external domain links; default false.' },
  timeout: { type: 'number', minimum: 10, maximum: 150, description: 'Timeout in seconds; default 60.' },
};

export const EXTRACT_PROPERTIES = {
  urls: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 10, description: 'One to ten public HTTP(S) URLs to read.' },
  query: { type: 'string', description: 'Optional query to return relevant excerpts instead of full page content.' },
  extract_depth: { type: 'string', enum: ['basic', 'advanced'], description: 'Default basic. Advanced retrieves more tables and embedded content and costs more.' },
  chunks_per_source: { type: 'integer', minimum: 1, maximum: 5, description: 'Relevant chunks per URL (default 3). Requires query.' },
  timeout: { type: 'number', minimum: 1, maximum: 60, description: 'Extraction timeout in seconds; default 30.' },
};
