# Choose how to run and pay for models

| Start here if… | Cost to check |
| --- | --- |
| You have enough memory for a local model and want inference on your machine | Model storage, available RAM or VRAM, and the time each turn takes. |
| You have access to an agent CLI Minnow supports | Your account's eligible models and usage limits. Verify the connection in **Models → Subscriptions**. |
| You want to pay an API provider for usage | Its current input, cached-input, and output prices for the exact model. Check minimum charges and account spending limits on the provider's dashboard. |

## Measure one real task

1. Connect your candidate in [Models](connect-a-model.md).
2. Run a typical task, such as reading a few files and explaining a failing test. Verify whether the model followed instructions and used its tools correctly.
3. Open **Models → Usage and cost** to check recorded tokens. If you enter the provider's unit prices, Minnow can estimate cost for recorded usage. Use the provider's dashboard for billed totals.
4. Check **Models → Routing** if you see usage from a model you did not select in the composer. Helpers or sub-agents may use a separate binding. Compare the whole task, including retries, before changing your default.

For local models, check memory fit in **Discover** at the context size you need. If loading fails or the machine swaps under load, try a shorter context or a smaller quantization before downloading several alternatives.
