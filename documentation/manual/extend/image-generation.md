# Generate workspace images

Use `/image-generation` to create raster assets while building a project. The image provider is separate from the chat model.

## Configure

Open **Models → Routing → Image generation** (also reached through Settings → Models & connections). Enable the binding, select an existing provider connection, choose **OpenAI Images** or **OpenRouter Images**, enter an image model ID and save. Manage credentials through Providers; the image binding contains no API key.

**Check connection** reads provider metadata without generating an image. Supported defaults appear after a successful check. A successful metadata check does not establish generation entitlement or available credit. **Generate test image** invokes the ordinary image tool and its permission gate.

## Generate and edit

The `generate_image` tool accepts a prompt and optional supported size, quality, format and background. Editing uses `operation: edit` and workspace-relative `reference_paths`. Reference files are uploaded to the selected provider. Originals and existing destination files are never overwritten. PNG, JPEG and WebP are supported; SVG is not.

Results contain the job ID, provider/model, dimensions, file hash and saved path. Default output is `assets/generated/<job-id>.<extension>`. The tool card previews the workspace asset and offers **Open asset** and **Copy path**. A text-only model receives metadata and cannot inspect pixels.

## Permissions and interrupted work

Generation defaults to **Ask**. Approval identifies the provider/model, destination and reference uploads; prices remain unknown unless the provider reports actual cost. **Off** blocks generation. Unattended callers require explicit **Full** permission. Plan mode can inspect configuration and job status but cannot generate or edit images. The skill can be disabled in Settings → Skills without changing permissions.

Use `image_generation_info` with `job_id` to inspect an interrupted call. Replaying the same execution identity never automatically submits another generation. `outcome_unknown` means the provider may have accepted the request; inspect the job instead of retrying blindly. Cancellation stops local work, but already accepted provider work may incur charges.

Generated files remain in the workspace after chat deletion. Operational records are kept separately under the Minnow home and excluded from backups. Provider-reported image usage is separate from chat token totals; missing cost is unknown, not zero.
