// Browser-safe schemas and validation shared by chat and server tools.
export const TAVILY_SEARCH_PROPERTIES = {
  max_results: { type: 'integer', minimum: 1, maximum: 20, description: 'Tavily: number of results (1–20). Defaults to the saved result count, capped at 20.' },
  search_depth: { type: 'string', enum: ['basic', 'advanced', 'fast', 'ultra-fast'], description: 'Tavily: basic by default; advanced improves relevance and costs 2 credits instead of 1.' },
  topic: { type: 'string', enum: ['general', 'news', 'finance'], description: 'Tavily: search category; defaults to general.' },
  include_domains: { type: 'array', items: { type: 'string' }, maxItems: 50, description: 'Tavily: restrict results to these domains.' },
  exclude_domains: { type: 'array', items: { type: 'string' }, maxItems: 50, description: 'Tavily: exclude these domains.' },
  time_range: { type: 'string', enum: ['day', 'week', 'month', 'year'], description: 'Tavily: relative date window. Use this or explicit dates.' },
  start_date: { type: 'string', description: 'Tavily: earliest date, YYYY-MM-DD.' },
  end_date: { type: 'string', description: 'Tavily: latest date, YYYY-MM-DD.' },
  chunks_per_source: { type: 'integer', minimum: 1, maximum: 3, description: 'Tavily: relevant snippets per result (1–3); unavailable with ultra-fast.' },
};

export function validateOptions(args, properties) {
  for (const [key, schema] of Object.entries(properties)) {
    const value = args[key];
    if (value === undefined) continue;
    if (schema.type === 'integer' || schema.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value) ||
          (schema.type === 'integer' && !Number.isInteger(value)) ||
          value < schema.minimum || value > schema.maximum) {
        throw new Error(`${key} must be ${schema.type === 'integer' ? 'an integer' : 'a number'} between ${schema.minimum} and ${schema.maximum}`);
      }
    } else if (schema.type === 'array') {
      if (!Array.isArray(value) || value.length > (schema.maxItems ?? 50) ||
          value.some((item) => typeof item !== 'string' || !item.trim() || item.length > 2048)) {
        throw new Error(`${key} must be an array of non-empty strings (maximum ${schema.maxItems ?? 50})`);
      }
    } else if (typeof value !== schema.type ||
        (schema.type === 'string' && (!value.trim() || value.length > 4096)) ||
        (schema.enum && !schema.enum.includes(value))) {
      throw new Error(`Invalid ${key}${schema.enum ? `; expected ${schema.enum.join(', ')}` : ''}`);
    }
  }
}

export function searchOptions(args, defaultCount = 8) {
  validateOptions(args, TAVILY_SEARCH_PROPERTIES);
  if (args.time_range && (args.start_date || args.end_date)) {
    throw new Error('Use time_range or start_date/end_date, not both');
  }
  for (const key of ['start_date', 'end_date']) {
    if (args[key] && (!/^\d{4}-\d{2}-\d{2}$/.test(args[key]) ||
        !Number.isFinite(Date.parse(args[key])) || new Date(args[key]).toISOString().slice(0, 10) !== args[key])) {
      throw new Error(`${key} must be a valid YYYY-MM-DD date`);
    }
  }
  if (args.start_date && args.end_date && args.start_date > args.end_date) {
    throw new Error('start_date must be on or before end_date');
  }
  if (args.search_depth === 'ultra-fast' && args.chunks_per_source !== undefined) {
    throw new Error('chunks_per_source is unavailable with ultra-fast search');
  }
  return {
    max_results: Math.min(20, Math.max(1, Math.round(defaultCount))),
    search_depth: 'basic',
    ...Object.fromEntries(Object.keys(TAVILY_SEARCH_PROPERTIES).filter((key) => args[key] !== undefined).map((key) => [key, args[key]])),
  };
}

export function unsupportedSearchOptions(args, provider) {
  if (provider === 'tavily') return '';
  const requested = Object.keys(TAVILY_SEARCH_PROPERTIES).filter((key) => args[key] !== undefined);
  return requested.length ? `Error: ${requested.join(', ')} require Tavily. Select Tavily in Settings → Integrations → Search.` : '';
}
