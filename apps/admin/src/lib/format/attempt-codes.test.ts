import { describe, expect, it } from 'vitest';
import { ATTEMPT_CODE_LABELS, attemptCodeLabel } from './attempt-codes.js';

describe('attemptCodeLabel', () => {
  it('maps a known skip_reason to its human label', () => {
    expect(attemptCodeLabel('no_response_schema_support')).toBe('No strict JSON schema support');
  });

  it('maps known error_class + outcome codes', () => {
    expect(attemptCodeLabel('client_abort')).toBe('Client disconnected');
    expect(attemptCodeLabel('circuit_open')).toBe('Circuit open');
    expect(attemptCodeLabel('upstream_error')).toBe('Provider error');
    expect(attemptCodeLabel('skipped')).toBe('Skipped');
  });

  it('falls back to the raw code for an unknown/future code (never blank)', () => {
    expect(attemptCodeLabel('some_new_reason_v2')).toBe('some_new_reason_v2');
  });

  it('returns empty string for null/undefined/empty', () => {
    expect(attemptCodeLabel(null)).toBe('');
    expect(attemptCodeLabel(undefined)).toBe('');
    expect(attemptCodeLabel('')).toBe('');
  });

  it('covers the full gateway SkipReason union (kept in sync with @helm/core)', () => {
    // Mirror of packages/core/src/capability/filter.ts SkipReason — every code the
    // capability filter can emit must have a human label here.
    const skipReasons = [
      'no_tool_support',
      'no_json_support',
      'no_response_schema_support',
      'no_vision_support',
      'no_audio_support',
      'no_video_support',
      'no_document_support',
      'context_too_small',
      'no_streaming_support',
      'no_nonstream_support',
      'no_cached_content_support',
    ];
    for (const code of skipReasons) {
      expect(ATTEMPT_CODE_LABELS[code], `missing label for ${code}`).toBeTruthy();
    }
  });
});
