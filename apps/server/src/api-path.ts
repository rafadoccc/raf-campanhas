import type { FastifyRequest } from 'fastify';

/** Use the route Fastify matched, not the raw URL supplied by the client. */
export function apiPath(request: FastifyRequest) {
  const matched = request.routeOptions.url;
  if (matched?.startsWith('/api/')) return matched;

  // Unknown routes still receive the API's protections and a JSON 404.
  const raw = request.url.split('?', 1)[0];
  try { return decodeURI(raw); }
  catch { return raw; }
}
