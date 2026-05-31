import { getClassifier } from '$lib/api/classifier.js';
import type { PageLoad } from './$types.js';

// SPA load: fetch the classifier config from the gateway admin API on the client.
export const load: PageLoad = async () => {
  const classifier = await getClassifier();
  return { classifier };
};
