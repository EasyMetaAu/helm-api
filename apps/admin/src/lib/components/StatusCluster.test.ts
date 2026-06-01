import { render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BuildInfo, HealthState } from '$lib/api/gateway.js';
import StatusCluster from './StatusCluster.svelte';

// The component is a pure consumer of the gateway + GitHub meta clients; we mock
// those and assert the widget renders each state correctly and never throws.
const getHealth = vi.fn<() => Promise<HealthState>>();
const getVersion = vi.fn<() => Promise<BuildInfo>>();
const getStarCount = vi.fn<() => Promise<number | null>>();

vi.mock('$lib/api/gateway.js', () => ({
  getHealth: () => getHealth(),
  getVersion: () => getVersion(),
}));

vi.mock('$lib/api/github.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./../api/github.js')>();
  return { ...actual, getStarCount: () => getStarCount() };
});

const version = (overrides: Partial<BuildInfo> = {}): BuildInfo => ({
  version: '0.1.0',
  gitSha: 'a1b2c3d',
  builtAt: '2026-05-30T00:00:00Z',
  ...overrides,
});

describe('StatusCluster', () => {
  beforeEach(() => {
    getHealth.mockReset().mockResolvedValue('online');
    getVersion.mockReset().mockResolvedValue(version());
    getStarCount.mockReset().mockResolvedValue(1234);
  });

  it('shows the live health label once the probe resolves', async () => {
    getHealth.mockResolvedValue('online');
    render(StatusCluster);
    await waitFor(() => expect(screen.getByText('Online')).toBeInTheDocument());
  });

  it.each([
    ['degraded', 'Degraded'],
    ['offline', 'Offline'],
  ] as const)('reflects the %s health state', async (state, label) => {
    getHealth.mockResolvedValue(state);
    render(StatusCluster);
    await waitFor(() => expect(screen.getByText(label)).toBeInTheDocument());
  });

  it('renders the version pill from /version', async () => {
    getVersion.mockResolvedValue(version({ version: '1.2.3' }));
    render(StatusCluster);
    await waitFor(() => expect(screen.getByTestId('gateway-version')).toHaveTextContent('v1.2.3'));
  });

  it('hides the version pill when the gateway reports an unknown version (dev)', async () => {
    getVersion.mockResolvedValue(version({ version: 'unknown' }));
    render(StatusCluster);
    await waitFor(() => expect(screen.getByTestId('github-link')).toBeInTheDocument());
    expect(screen.queryByTestId('gateway-version')).not.toBeInTheDocument();
  });

  it('shows a formatted star count when available', async () => {
    getStarCount.mockResolvedValue(1234);
    render(StatusCluster);
    await waitFor(() => expect(screen.getByTestId('github-stars')).toHaveTextContent('1.2k'));
  });

  it('links to the GitHub repo and omits the count when stars are unavailable', async () => {
    getStarCount.mockResolvedValue(null);
    render(StatusCluster);
    const link = await screen.findByTestId('github-link');
    expect(link).toHaveAttribute('href', 'https://github.com/EasyMetaAu/helm-api');
    expect(screen.queryByTestId('github-stars')).not.toBeInTheDocument();
  });

  it('fails open: still renders when every meta call rejects (no throw)', async () => {
    getHealth.mockRejectedValue(new Error('unreachable'));
    getVersion.mockRejectedValue(new Error('no version'));
    getStarCount.mockRejectedValue(new Error('no stars'));
    render(StatusCluster);
    // GitHub link is always present; health degrades to Offline.
    await waitFor(() => expect(screen.getByText('Offline')).toBeInTheDocument());
    expect(screen.getByTestId('github-link')).toBeInTheDocument();
    expect(screen.queryByTestId('gateway-version')).not.toBeInTheDocument();
  });
});
