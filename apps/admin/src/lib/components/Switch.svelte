<script lang="ts">
  // Shared on/off switch. A real button with role="switch" so screen readers and
  // tests read its state from aria-checked; styling lives in app.css (.switch).
  let {
    checked,
    label,
    disabled = false,
    title,
    onchange,
  }: {
    checked: boolean;
    label: string;
    disabled?: boolean;
    title?: string;
    onchange: (checked: boolean) => void;
  } = $props();
</script>

<button
  type="button"
  role="switch"
  class="switch"
  aria-checked={checked}
  aria-label={label}
  {disabled}
  {title}
  onclick={() => onchange(!checked)}
>
  <span class="switch-track"><span class="switch-thumb"></span></span>
</button>
