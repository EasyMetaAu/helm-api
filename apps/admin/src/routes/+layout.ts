// Pure SPA: no SSR, no prerender. The bundle is served statically by Hono at
// /admin and all routing happens client-side (adapter-static fallback).
export const ssr = false;
export const prerender = false;
