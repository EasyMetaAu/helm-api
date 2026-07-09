<script lang="ts">
  // The real Helm mark (identical to the admin layout logo) — indigo rounded
  // square + the two rudder posts and arrow. Never an ad-hoc emoji.
  let { size = "md" }: { size?: "sm" | "md" } = $props();
  const box = $derived(size === "sm" ? "h-7 w-7" : "h-8 w-8");
  const glyph = $derived(size === "sm" ? "h-4 w-4" : "h-5 w-5");
</script>

<span
  class="flex {box} items-center justify-center rounded-lg bg-indigo-600 text-white"
>
  <svg viewBox="0 0 64 64" class={glyph} fill="none" aria-hidden="true">
    <g fill="currentColor">
      <rect x="15" y="16" width="7" height="32" rx="3.5" />
      <rect x="42" y="16" width="7" height="32" rx="3.5" />
    </g>
    <g
      fill="none"
      stroke="currentColor"
      stroke-width="5"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M22 32H38" />
      <path d="M34 27l6 5-6 5" />
    </g>
  </svg>
</span>
