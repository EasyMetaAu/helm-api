<script lang="ts">
  import {
    isCodexCreditPromoRestriction,
    servingAccountLabel,
  } from '$lib/format/serving-account.js';
  import type { RequestDetail } from '$lib/api/requests.js';
  import { attemptCodeLabel } from '$lib/format/attempt-codes.js';
  import { t } from '$lib/i18n';

  let { detail: d }: { detail: RequestDetail } = $props();
  // Explain the recorded trail only. A committed provider attempt is not proof
  // that the client received a complete stream.
  const delivered = $derived(d.status === 'ok' && d.stream_outcome === 'completed');
  const firstSuccess = $derived(d.provider_attempts.findIndex((a) => a.outcome === 'success'));
  const earlierFailure = $derived(
    firstSuccess < 0
      ? undefined
      : d.provider_attempts
          .slice(0, firstSuccess)
          .find((a) => !['success', 'skipped', 'circuit_open'].includes(a.outcome)),
  );
  const restrictedAttempt = $derived(
    d.provider_attempts.find((attempt) =>
      isCodexCreditPromoRestriction(attempt.error_detail ?? null),
    ),
  );
  const selection = $derived(d.serving_account?.selection);
  const strategies = {
    balanced: 'Balanced',
    manual_priority: 'Manual priority',
    low_risk: 'Low risk',
    use_expiring: 'Avoid waste',
    fastest: 'Speed first',
  };
</script>

<section
  class="card space-y-2 break-words text-sm"
  aria-labelledby="routing-summary-title"
  data-testid="routing-explanation"
>
  <h2 id="routing-summary-title" class="section-header">{$t('What happened')}</h2>
  <p class="font-medium text-ink-strong" role="status">
    {#if d.stream_outcome === 'client_aborted'}
      {$t('The client disconnected before the response completed.')}
    {:else if d.status === 'error' && restrictedAttempt}
      {$t('OpenAI blocked Codex usage for {account}.', {
        account: d.serving_account ? servingAccountLabel(d.serving_account) : '—',
      })}
    {:else if d.status === 'error' || (d.stream_outcome && d.stream_outcome !== 'completed')}
      {$t('The response did not complete. Check the execution details below.')}
    {:else if delivered && d.final_model}
      {#if earlierFailure}
        {$t('An earlier attempt failed; {model} completed the response.', { model: d.final_model })}
      {:else}
        {$t('{model} completed the response.', { model: d.final_model })}
      {/if}
    {:else if d.final_model && d.status === 'ok'}
      {$t('The request succeeded; stream completion was not recorded.')}
    {:else}
      {$t('No completion evidence was recorded.')}
    {/if}
  </p>
  {#if d.status === 'error' && restrictedAttempt}
    <p class="text-ink-body">
      {$t(
        'OpenAI treated this request as Codex BYOK and rejected it because of the organization’s monthly API Credits benefit. This does not mean all requests using this key will fail; the recorded error does not show which request detail triggered this classification.',
      )}
    </p>
    <p class="text-ink-body">
      {$t(
        'An organization owner can review the benefit in OpenAI billing. Cancelling it changes billing benefits; use another eligible key if you want to keep it.',
      )}
      <a
        class="link underline"
        href="https://platform.openai.com/settings/organization/billing/overview"
        target="_blank"
        rel="noopener noreferrer">{$t('OpenAI organization billing')}</a
      >
    </p>
  {/if}
  {#if delivered && earlierFailure}
    <p class="text-ink-body">
      {earlierFailure.model}:
      <span>{$t(attemptCodeLabel(earlierFailure.error_class ?? earlierFailure.outcome))}</span>
    </p>
  {/if}
  <p class="text-ink-body">
    {#if d.policy_reason === 'stateful Responses continuation'}
      {$t('This conversation must continue with the provider holding its state.')}
    {:else if d.policy_reason === 'explicit model passthrough'}
      {$t('The client chose an exact model; Helm passed the request to it.')}
    {:else if d.matched_policy}
      {$t('Policy {policy} selected lane {lane}.', {
        policy: d.matched_policy,
        lane: d.lane || '—',
      })}
    {:else if d.lane && d.classifier_output.decided_by === 'fallback'}
      {$t('Classification used the fallback lane: {lane}.', { lane: d.lane })}
    {:else if d.lane && d.classifier_output.decided_by === 'rules'}
      {$t('Routing rules selected lane {lane}.', { lane: d.lane })}
    {:else if d.lane && d.classifier_output.decided_by === 'eval'}
      {$t('The classifier model selected lane {lane}.', { lane: d.lane })}
    {:else if d.lane}
      {$t('Recorded lane: {lane}.', { lane: d.lane })}
    {/if}
  </p>
  {#if selection && d.serving_account}
    <p class="text-ink-body">
      {#if selection.reason === 'sticky_hit'}
        {$t('Account {account} was kept for this conversation.', {
          account: servingAccountLabel(d.serving_account),
        })}
      {:else if selection.reason === 'hash_assign'}
        {$t('Account {account} was assigned by session distribution.', {
          account: servingAccountLabel(d.serving_account),
        })}
      {:else if selection.reason === 'lru'}
        {$t('Account {account} was selected by least recent use.', {
          account: servingAccountLabel(d.serving_account),
        })}
      {:else}
        {$t('Account {account} was selected by {strategy}.', {
          account: servingAccountLabel(d.serving_account),
          strategy: $t(strategies[selection.strategy]),
        })}
      {/if}
    </p>
  {/if}
</section>
