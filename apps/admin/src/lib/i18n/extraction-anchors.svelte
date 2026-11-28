<!--
  i18n EXTRACTION ANCHORS — never rendered, never imported.

  `easyi18n extract` only sees STATIC `$t('literal')` calls. A handful of strings
  are referenced ONLY via dynamic `$t(variable)`:
    • routes/+layout.svelte      — sidebar nav `item.label` / `item.desc`, `activeLabel`
    • routes/+page.svelte        — dashboard quick-link `c.label` / `c.desc`
    • lib/components/DimensionTable.svelte — `dim.direction` ("up" / "down")
    • lib/components/DecisionChain.svelte  — `decidedBy().key` (decision source),
                                             `evalReasonKey()` (eval fail-open reason)
  Without a static reference, `pnpm i18n:sync` prunes them from every locale and
  they fall back to raw English (e.g. the nav showing "Dashboard" / English subtitles).

  Listing them statically here keeps + translates them through i18n:sync.
  ⚠️  When you add or rename a dynamic nav item, quick-link, or direction, add its
  string(s) below as well.
-->
<script lang="ts">
  import { t } from './index';
</script>

{#if false}
  <!-- nav + quick-link labels -->
  {$t('Dashboard')}{$t('Requests')}{$t('Lanes')}{$t('Policies')}{$t('Classifier')}{$t('API Keys')}
  {$t('Memory')}{$t('Providers')}{$t('Settings')}
  <!-- sidebar nav subtitles -->
  {$t('Traffic and health at a glance')}
  {$t('Every request and the lane it took')}
  {$t('Quality tiers and fallback models')}
  {$t('Rules that override or cap the lane')}
  {$t('How a request is matched to a lane')}
  {$t('Client keys and their lane limits')}
  {$t('Facts and reflections the gateway remembers')}
  {$t('Connect AI subscriptions')}
  {$t('xAI/SuperGrok is also available.')}
  {$t('System Settings')}
  <!-- dashboard quick-link descriptions -->
  {$t('See the full decision trail for every request the gateway handled.')}
  {$t('Set the primary model and fallback chain for each quality and cost tier.')}
  {$t('Add match rules that force a lane or cap the highest lane a request may use.')}
  {$t('Tune how requests are sorted into lanes, by rules or optional small-model eval.')}
  {$t('Issue and revoke client keys, and cap the top lane each key may reach.')}
  <!-- DimensionTable direction -->
  {$t('up')}{$t('down')}
  <!-- DecisionChain: classifier decision-source labels (decidedBy().key) -->
  {$t('Decided by Layer-1 rules')}
  {$t('Decided by the Layer-2 eval model')}
  {$t('Classification used the terminal fallback lane')}
  {$t('Default (explicit passthrough or fail-open)')}
  <!-- DecisionChain: eval fail-open reasons (evalReasonKey()) -->
  {$t('timed out')}{$t('provider error')}{$t('circuit open')}
  {$t('returned non-JSON')}{$t('returned an invalid schema')}
  <!-- DecisionChain: pinned single-candidate chain reasons (pinReasonLabel()) -->
  {$t(
    'Conversation continuation — pinned to the provider holding the conversation state, so there is no fallback.',
  )}
  {$t('The client named this exact model, so routing passed it through without fallback.')}
  {$t('Image generation is pinned to the requested model, so there is no fallback.')}
  <!-- Providers: Claude reset kinds (RESET_KIND_LABEL/ACTION/EFFECT) -->
  {$t('Weekly limit resets')}
  {$t('Fable resets')}
  {$t('Other Claude resets')}
  {$t('Reset weekly limit')}
  {$t('Reset Fable allowance')}
  {$t('Reset Claude usage')}
  {$t('Resets the whole 7-day limit for this Claude account.')}
  {$t('Refills the Fable allowance and gives back what Fable used of the weekly limit. It does not reset the whole week.')}
  {$t('Restores the Claude limits listed below.')}
  <!-- Providers list: sortable column labels (sortLabel()) -->
  {$t('Account')}{$t('Remaining')}{$t('Used')}{$t('Calls')}{$t('Priority')}
{/if}
