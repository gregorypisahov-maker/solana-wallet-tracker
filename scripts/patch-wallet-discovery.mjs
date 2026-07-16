import fs from 'node:fs';

const path = 'worker/walletDiscovery.ts';
const source = fs.readFileSync(path, 'utf8');

const start = source.indexOf('async function fetchCandidates(): Promise<Candidate[]> {');
const end = source.indexOf('\n\nexport async function discoverTrialWallets', start);

if (start < 0 || end < 0) {
  console.log('[wallet-discovery-patch] skipped: fetchCandidates block not found');
  process.exit(0);
}

const replacement = `async function fetchCandidates(): Promise<Candidate[]> {
  const configuredEndpoints = [
    process.env.GMGN_WALLET_DISCOVERY_URL,
    process.env.GMGN_WALLET_DISCOVERY_FALLBACK_URL,
  ].filter((value): value is string => Boolean(value?.trim()));

  const endpoints = [...new Set([
    ...configuredEndpoints,
    GMGN_ENDPOINT,
    GMGN_ENDPOINT.includes('?') ? \`${GMGN_ENDPOINT}&limit=100\` : \`${GMGN_ENDPOINT}?limit=100\`,
  ])];

  const optionalCookie = process.env.GMGN_WALLET_DISCOVERY_COOKIE?.trim();
  const optionalAuthorization = process.env.GMGN_WALLET_DISCOVERY_AUTHORIZATION?.trim();
  const failures: string[] = [];

  for (const endpoint of endpoints) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const headers: Record<string, string> = {
        accept: 'application/json, text/plain, */*',
        'accept-language': 'en-US,en;q=0.9',
        'cache-control': 'no-cache',
        pragma: 'no-cache',
        referer: 'https://gmgn.ai/',
        origin: 'https://gmgn.ai',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        'user-agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      };

      if (optionalCookie) headers.cookie = optionalCookie;
      if (optionalAuthorization) headers.authorization = optionalAuthorization;

      const response = await fetch(endpoint, {
        signal: controller.signal,
        headers,
      });

      if (!response.ok) {
        const body = (await response.text()).slice(0, 180).replace(/\\s+/g, ' ');
        failures.push(\`${response.status} from ${new URL(endpoint).host}${body ? \`: ${body}\` : ''}\`);
        continue;
      }

      const payload: unknown = await response.json();
      const objects: Record<string, unknown>[] = [];
      collectObjects(payload, objects);

      const byAddress = new Map<string, Candidate>();
      for (const record of objects) {
        const candidate = toCandidate(record);
        if (!candidate) continue;
        const previous = byAddress.get(candidate.address);
        if (!previous || candidate.score > previous.score) {
          byAddress.set(candidate.address, candidate);
        }
      }

      const candidates = [...byAddress.values()].sort((a, b) => b.score - a.score);
      console.log(
        \`[wallet-discovery] source accepted ${candidates.length} eligible candidate(s) from ${new URL(endpoint).host}\`
      );
      return candidates;
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error(
    \`GMGN candidate sources rejected every request: ${failures.join(' | ') || 'no endpoint succeeded'}\`
  );
}`;

fs.writeFileSync(path, source.slice(0, start) + replacement + source.slice(end));
console.log('[wallet-discovery-patch] installed: multi-endpoint retries + browser headers');
