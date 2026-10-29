const root = new URL('../', import.meta.url);
export async function resolve(spec, ctx, next) {
  if (spec === 'three') return next(new URL('vendor/three/three.module.min.js', root).href, ctx);
  if (spec.startsWith('three/addons/')) return next(new URL(`vendor/three/addons/${spec.slice(13)}`, root).href, ctx);
  return next(spec, ctx);
}
