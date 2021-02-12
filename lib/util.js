function merge(dest, src) {
  for (let key in src) {
    let value = src[key];
    if (typeof value === 'object') {
      value = merge(dest[key] || {}, value);
    }
    dest[key] = value;
  }
  return dest;
}
exports.merge = merge;
