<script lang="ts">
  import { page } from "$app/stores";
  import { base } from "$app/paths";
  import { t } from "$lib/i18n";
  import RequestDetailView from "$lib/components/RequestDetailView.svelte";
  import { getRequest, getRequestPayloadMeta, type RequestDetail, type RequestPayloadView } from "$lib/api/request-trail";
  const requestId = $derived($page.params.traceId ?? "");
  let detail = $state<RequestDetail | null>(null);
  let payload = $state<RequestPayloadView>({ captured: false });
  let loading = $state(true);
  let loadError = $state("");
  $effect(() => {
    const id = requestId;
    let active = true;
    loading = true;
    detail = null;
    payload = { captured: false };
    loadError = "";
    void Promise.all([getRequest(id), getRequestPayloadMeta(id)]).then(([nextDetail,nextPayload])=>{
      if (!active) return;
      detail = nextDetail;
      payload = nextPayload;
    }).catch(error=>{if(active) loadError = error instanceof Error ? error.message : String(error);})
      .finally(()=>{if(active) loading = false;});
    return () => {active = false;};
  });
</script>
{#if loading}
  <p class="empty-state">{$t("Loading")}</p>
{:else}
  {#key requestId}
    <RequestDetailView data={{detail,payload,requestId,loadError,backTo:`${base}/requests`}} />
  {/key}
{/if}
