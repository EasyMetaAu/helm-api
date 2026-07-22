<!--
  i18n EXTRACTION ANCHORS — never rendered, never imported.

  `easyi18n extract` only sees static `$t('literal')` calls. These strings are
  otherwise referenced only through dynamic labels or status values, so an
  i18n sync would remove them and the UI would fall back to English.

  Add every new dynamic translation key here when it has no static call site.
-->
<script lang="ts">
  import { t } from "./index";
</script>

{#if false}
  <!-- sidebar navigation -->
  {$t("Connect")}
  <!-- request date ranges -->
  {$t("Today")}{$t("Yesterday")}
  <!-- memory fact status -->
  {$t("pruned")}
{/if}
