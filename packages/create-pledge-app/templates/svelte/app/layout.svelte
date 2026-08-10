<script lang="ts">
  // Root layout — wraps all pages
  let { children } = $props();
</script>

<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>PledgeStack Svelte App</title>
  </head>
  <body>
    {@render children()}
  </body>
</html>
