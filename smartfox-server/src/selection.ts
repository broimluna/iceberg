// The client's SelectionBehaviour (Random 0, Ordered 1, NonRepeatingRandom 2):
// how the server picks the next geyser or target superset. Returns a
// function giving child indices in [0, count).
import type { Behaviour } from "./world-data.ts";

export function createPicker(behaviour: Behaviour, count: number, random: () => number = Math.random): () => number {
  if (behaviour === "ordered") {
    let i = -1;
    return () => (i = (i + 1) % count);
  }
  if (behaviour === "random") return () => Math.floor(random() * count);

  // nonRepeatingRandom: a shuffled pass, reshuffled after each full pass.
  // A new pass doesn't start with the previous pass's last pick.
  let pass: number[] = [];
  let last = -1;
  return () => {
    if (pass.length === 0) {
      pass = Array.from({ length: count }, (_, i) => i);
      for (let i = pass.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [pass[i], pass[j]] = [pass[j]!, pass[i]!];
      }
      if (count > 1 && pass[0] === last) [pass[0], pass[count - 1]] = [pass[count - 1]!, pass[0]!];
    }
    last = pass.shift()!;
    return last;
  };
}
