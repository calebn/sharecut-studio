/**
 * `compute` memoized per argument identity in a `WeakMap`: the same object
 * returns the cached value, and a collected key frees its entry. For values
 * derived from an immutable store array (a new array means new contents).
 */
export function memoByRef<K extends object, V>(
  compute: (key: K) => V,
): (key: K) => V {
  const cache = new WeakMap<K, V>();
  return (key) => {
    if (cache.has(key)) {
      return cache.get(key) as V;
    }
    const value = compute(key);
    cache.set(key, value);
    return value;
  };
}
