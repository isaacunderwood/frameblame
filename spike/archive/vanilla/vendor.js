/* Pretend third party. Line 8 is the hot loop. */
window.vendorTrack = function vendorTrack() {
  const start = performance.now();
  let acc = 0;
  while (performance.now() - start < 12) {
    for (let i = 0; i < 2000; i += 1) {
      acc += Math.sqrt(i) * Math.sin(i);
    }
  }
  return acc;
};
