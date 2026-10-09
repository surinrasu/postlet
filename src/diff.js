/** Longest increasing subsequence retains stable ids without quadratic diffing. */
/** @param {!Array<string>} previous @param {!Array<string>} current @return {{removed: !Array<string>, added: !Array<{id:string,index:number}>}} */
export function diffIds(previous, current) {
  const oldPosition = new Map(previous.map((id, i) => [id, i]));
  const candidates = current.map((id) => oldPosition.get(id) ?? -1);
  const tails = [],
    links = new Array(current.length).fill(-1);
  for (let i = 0; i < candidates.length; i++) {
    if (candidates[i] < 0) continue;
    let lo = 0,
      hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (candidates[tails[mid]] < candidates[i]) lo = mid + 1;
      else hi = mid;
    }
    links[i] = lo > 0 ? tails[lo - 1] : -1;
    tails[lo] = i;
  }
  const keep = new Set();
  for (let i = tails.at(-1) ?? -1; i >= 0; i = links[i]) keep.add(current[i]);
  return {
    removed: previous.filter((id) => !keep.has(id)),
    added: current.flatMap((id, index) =>
      keep.has(id) ? [] : [{ id, index }],
    ),
  };
}
