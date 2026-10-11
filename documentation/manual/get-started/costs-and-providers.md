# Costs and providers

Minnow itself is free. The models are where the money goes, and there are four ways to pay for them: per token, by subscription, by a capped monthly gateway plan, or upfront for hardware. This page compares them so you can pick a starting point, and it covers a setup that costs nothing at all.

Prices were checked on **9 October 2026**. They change often, sometimes monthly, so confirm on the provider's own pricing page before you commit money. Each section links to it. All prices are in US dollars.

## The short version

| Your situation | Start with |
|----------------|------------|
| You want to spend nothing and have no strong GPU | The [free cloud stack](#free-cloud-options): Gemini free tier, OpenRouter free models, Groq |
| You want to spend nothing and have a 24 GB GPU or a 32 GB+ Mac | [Local models](#local-hardware), served from **Models → Discover** |
| You want the most capability per dollar, paying as you go | [DeepSeek](#deepseek) — top up $5 and see how far it goes |
| You want one flat monthly price with many models behind one key | [OpenCode Go](#opencode-go) at $10/month |
| You work in Minnow all day and want the strongest models | A [Claude or ChatGPT subscription](#subscriptions-through-agent-clis) through its agent CLI |
| Your code cannot leave your machine | [Local models](#local-hardware), and nothing else |

You can have several of these at once. A common setup: a subscription or DeepSeek for the main chat, and a free or very cheap model for background work through [Routing](connect-a-model.md#routing-which-model-does-what).

## What has worked for us

These are the Minnow team's own results from daily use building Minnow. They are not benchmarks, and your work may favour different models.

- **Claude and ChatGPT subscriptions**, used through the Claude Code and Codex CLIs, give the best results on hard, multi-step work.
- **OpenCode Go** is the best flat-price deal: $10 a month gets you DeepSeek, GLM, Kimi, Qwen, MiniMax and more behind one key.
- **DeepSeek** has been the most cost-efficient model we have used. V4 Flash is good enough for most everyday agent work, and V4 Pro handles harder tasks at a fraction of frontier prices.
- **Local models:** **Qwen 3.8 27B** is the best all-round local model we have run, and it fits a 24 GB GPU or a 32 GB Mac. If you have the memory, **Qwen3.8-Flash-Next** is the next step up: a 125B mixture-of-experts model with only 6B parameters active per token, so it runs quickly once it fits. It needs roughly 75 GB or more.

## How the billing models differ

**Pay per token (API keys).** You pay for what you send and receive, metered in millions of tokens (MTok). Prices come in three parts: *input* (what you send), *cached input* (input the provider has seen recently, billed at a steep discount), and *output* (what the model writes). Output costs the most per token.

An agent chat resends the whole conversation every round, so most of what you pay for is input the provider has already seen. That makes the **cached input price** the number that matters most for Minnow. Two models with the same headline price can differ in cost by several times once caching is counted.

**Subscriptions through an agent CLI.** Claude Pro/Max, ChatGPT Plus/Pro and Cursor plans are a flat monthly fee with usage limits that reset on rolling windows, usually every five hours, with a weekly cap on top. Minnow uses them through the vendor's own CLI ([Agent CLIs](connect-a-model.md#agent-clis)). Limits are not published in tokens. If you hit one, you wait for the window to reset or buy extra usage from the vendor.

**Capped gateway plans.** OpenCode Go, GitHub Copilot, Ollama Cloud, and the coding plans sold by model labs give you an API key with a monthly allowance, often measured in dollars of usage. They work like a pay-per-token key, but your bill is fixed.

**Local hardware.** No per-token cost and no limits, but you pay upfront for the machine, plus electricity. Quality depends on how much memory you have.

## What an hour of agent work costs

To make per-token prices comparable, here is the cost of 100 agent rounds, roughly an hour of steady Build-mode work. Each round assumes 40,000 prompt tokens (36,000 cached, 4,000 new) and 1,000 output tokens. Your sessions will vary. Different model families also split text into tokens differently, so the same work can produce more tokens on one model than another; recent Claude models produce about 30% more tokens for the same text.

| Model | Where | Approx. cost per 100 rounds |
|-------|-------|-----------------------------|
| GPT-6 Luna | OpenAI API | $0.13 |
| DeepSeek V4.1 Flash, off-peak | DeepSeek API | $0.13 |
| Claude Haiku 5.5 | Anthropic API | $0.14 |
| GLM 5.3 Flash | OpenCode Zen | $0.22 |
| DeepSeek V4.1 Flash, peak | DeepSeek API | $0.26 |
| DeepSeek V4 Pro, off-peak | DeepSeek API | $0.54 |
| DeepSeek V4 Pro, peak | DeepSeek API | $1.08 |
| GPT-6.1 Sol | OpenAI API | $2.16 |
| Claude Sonnet 5.5 | Anthropic API | $2.36 |
| Kimi K3 | OpenCode Zen | $3.78 |
| Claude Opus 5.5 | Anthropic API | $4.72 |

Two things stand out. The small models (Luna, Haiku 5.5, DeepSeek Flash) are cheap enough that cost barely matters for a single person. And the frontier models cost roughly 10 to 35 times more, which is why it pays to send background work to a cheap model and keep the expensive one for the turns that need it.

## Pay-per-token APIs

Prices per million tokens. "Cached" is the cache-hit input price.

| Provider | Model | Input | Cached | Output | In Minnow |
|----------|-------|------:|-------:|-------:|-----------|
| DeepSeek | V4.1 Flash (peak) | $0.30 | $0.006 | $1.20 | Preset |
| DeepSeek | V4 Pro (peak) | $1.32 | $0.044 | $3.96 | Preset |
| Anthropic | Claude Haiku 5.5 (≤100K prompt) | $0.10 | $0.01 | $0.50 | Preset |
| Anthropic | Claude Sonnet 5.5 | $2.00 | $0.10 | $10.00 | Preset |
| Anthropic | Claude Opus 5.5 | $4.00 | $0.20 | $20.00 | Preset |
| OpenAI | GPT-6 Luna | $0.10 | $0.01 | $0.50 | Preset |
| OpenAI | GPT-6.1 Sol | $2.00 | $0.10 | $10.00 | Preset |
| OpenAI | GPT-6 Astra | $10.00 | $1.00 | $50.00 | Preset |
| Google | Gemini 3.8 Flash | $0.75 | — | $3.75 | Custom |
| Google | Gemini 3.1 Pro (≤200K prompt) | $2.00 | — | $12.00 | Custom |

Anthropic caching also bills a *cache write* the first time content is stored, a little above the normal input price. Anthropic and OpenAI both offer a 50% Batch API discount, but batch jobs are asynchronous and not used by interactive chat. Google has announced that Gemini 3.8 Flash and 3.6 Flash prices double on 1 January 2027.

Pricing pages: [DeepSeek](https://api-docs.deepseek.com/quick_start/pricing) · [Anthropic](https://platform.claude.com/docs/en/about-claude/pricing) · [OpenAI](https://developers.openai.com/api/docs/pricing) · [Google Gemini](https://ai.google.dev/gemini-api/docs/pricing)

### DeepSeek

DeepSeek has two models, both with a 1M-token context:

- **`deepseek-flash`** (DeepSeek-V4.1-Flash) is the everyday model. The older names `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` still work and bill at the Flash price.
- **`deepseek-v4-pro`** is the stronger model for planning, review and hard debugging.

**Off-peak hours halve every price.** Peak is 01:00–04:00 and 06:00–10:00 UTC, Monday to Friday. Every other hour is off-peak, including weekends and Chinese public holidays. In the Americas the whole working day is off-peak. In Europe, peak covers the morning until about 11:00 or 12:00 local time.

DeepSeek's cache-hit price is about 2% of its normal input price, so long agent chats stay cheap. There is no charge for writing to the cache.

To set it up, create a key at [platform.deepseek.com](https://platform.deepseek.com), add credit (billing is prepaid, so you cannot overspend), then add the **DeepSeek** preset in **Models → Providers**.

DeepSeek is operated from China. Read its privacy policy before you send it code you are not allowed to share.

### Gateways: one key, many models

| Gateway | How it bills | Notes | In Minnow |
|---------|--------------|-------|-----------|
| [OpenCode Zen](https://opencode.ai/docs/zen/) | Prepaid credit, pay per request at roughly list price | Claude, GPT, Gemini, Grok, Kimi, GLM, DeepSeek, Qwen, MiniMax and more. Card fees (4.4% + $0.30) are passed through. Auto-reload is on by default ($20 when the balance falls below $5), so turn it off if you want a hard cap. | Preset |
| [OpenRouter](https://openrouter.ai) | Prepaid credit | Hundreds of models from many hosts, plus free `:free` models | Preset |
| [Groq](https://console.groq.com) | Pay per token, free tier | Very fast inference of open-weight models | Preset |
| [Mistral](https://mistral.ai/pricing) | Pay per token, free tier | Mistral and Devstral models | Preset |

A gateway is the easiest way to try many models without opening an account with every lab. You pay the gateway's price, which is usually close to the lab's own.

## Subscriptions through agent CLIs

These plans run through the vendor's official CLI, which Minnow drives from **Models → CLIs**. Your usage limits are shared with the vendor's own apps, so time spent in the Claude app or ChatGPT counts against the same pool. Minnow shows your remaining account usage where the CLI reports it ([Models → CLIs](../apps/models.md#clis)).

| Plan | Price | What you get in Minnow |
|------|-------|------------------------|
| **Claude Pro** | $20/month, or $17/month billed yearly | Claude Code. At least 5× Free's usage per five-hour session, plus weekly limits |
| **Claude Max** | From $100/month | 5× or 20× Pro's usage, higher output limits |
| **ChatGPT Free** | $0 | Limited Codex access |
| **ChatGPT Go** | $8/month | Codex for light tasks, higher limits than Free |
| **ChatGPT Plus** | $20/month | Expanded Codex limits, optional paid credits beyond them |
| **ChatGPT Pro** | $100 or $200/month | 5× or 20× Plus's limits |
| **Cursor Hobby** | $0 | Limited agent requests |
| **Cursor Pro** | $20/month | Extended agent limits, frontier models |

Claude's Free plan does not include Claude Code, so Claude in Minnow starts at Pro. Since April 2026, Codex usage on paid ChatGPT plans is metered in credits rather than messages. Team and Business plans exist for each vendor at higher per-seat prices.

**When a subscription is the better deal:** if you would otherwise spend more than about $20 a month on frontier-model API calls, Pro or Plus usually costs less. Under that, pay per token. If you keep hitting the five-hour limit on Pro or Plus, compare the next tier against the API cost of the same work using the table above.

Pricing pages: [Claude](https://claude.com/pricing) · [ChatGPT](https://chatgpt.com/pricing) · [Cursor](https://cursor.com/pricing)

## Capped monthly plans

### OpenCode Go

**$10/month** (Go) or **$40/month** (Go Plus) for one key covering DeepSeek V4 Pro and V4.1 Flash, GLM 5.3, Kimi K3, Qwen 3.8, MiniMax M3, Grok, GPT Luna, Claude Haiku 5.5 and others. Add it with the **OpenCode Go** preset.

Each model has a monthly dollar allowance (for example, Go includes $60 of GLM-5.3-Flash and $15 of Kimi K3). At most 20% of a model's allowance can go in any five-hour window, and 50% in any week. When a model runs out you can keep using the free models, or turn on **Use balance** to continue from an OpenCode Zen balance. Details: [opencode.ai/docs/go](https://opencode.ai/docs/go/).

### GitHub Copilot

| Plan | Price | Usage |
|------|-------|-------|
| Free | $0 | 50 chat requests and 2,000 completions a month |
| Pro | $10/month | $10 of AI credits, plus $5 of flex usage |
| Pro+ | $39/month | $39 of AI credits, plus $31 of flex usage |
| Max | $100/month | $100 of AI credits, plus $100 of flex usage |

Every plan includes Claude, GPT, Gemini, Grok and Kimi models. One AI credit is $0.01, and overage on paid plans draws down at that rate. Add it with the **GitHub Copilot** preset, which needs a Copilot OAuth token. Details: [github.com/features/copilot/plans](https://github.com/features/copilot/plans).

### Ollama Cloud

Free (a small set of starter models, one request at a time), **Pro** at $20/month ($60 of included usage, three concurrent requests), or **Max** at $100/month ($300 of usage, ten concurrent). It hosts DeepSeek, GLM, Kimi, MiniMax, gpt-oss, Mistral Large and Nemotron models. Sign in to Ollama, and its cloud models run through your normal Ollama provider. Running models on your own hardware stays unlimited. Details: [ollama.com/pricing](https://ollama.com/pricing).

### Lab coding plans

Z.ai (GLM, from about $18/month), Moonshot (Kimi, from about $19/month), MiniMax (from about $20/month) and Alibaba Cloud (Qwen) sell their own coding plans. Each lab measures its quota differently (prompts, requests, credits or tokens), so the headline prices are hard to compare. Connect one with **Custom** in **Models → Providers**, using the OpenAI-compatible base URL from the lab's documentation. If you want several of these models, OpenCode Go usually costs less than subscribing to each lab.

## Free cloud options

All of these work without paying. The trade-off is limits, and in several cases **your prompts may be used to train models**. Do not send code you are not allowed to share to a free tier unless its terms say it is not used for training.

| Service | Free allowance | Training on your data? | Set up in Minnow |
|---------|----------------|------------------------|------------------|
| [Google Gemini API](https://aistudio.google.com) | Gemini 3.8 Flash, 3.6 Flash, Flash-Lite and 2.5 models, rate-limited | Yes, except in the EEA, UK and Switzerland | Custom (see below) |
| [OpenRouter](https://openrouter.ai) `:free` models | 20 requests/minute; 50/day, or 1,000/day once you have bought $10 of credit at any point | Some free hosts log prompts | Preset; pick a model ending in `:free` |
| [Groq](https://console.groq.com) | Per model: 30 requests/minute, 1,000/day, 200K tokens/day | Check terms | Preset |
| [OpenCode Zen](https://opencode.ai/docs/zen/) free models | Several free models for a limited time, rotated regularly | Some do | Preset |
| [Mistral](https://console.mistral.ai) Experiment plan | Free API use after phone verification, with low rate limits | Yes, unless you opt out | Preset |
| [NVIDIA](https://build.nvidia.com) API catalog | About 40 requests/minute per model with an NVIDIA Developer Program account | Check terms; evaluation use only | Custom, base URL `https://integrate.api.nvidia.com` |
| GitHub Copilot Free | 50 chat requests a month | Check terms | Preset |
| Ollama Cloud Free | Starter models, one request at a time | Check terms | Your Ollama provider |
| ChatGPT Free, Cursor Hobby | Limited Codex or agent use | Vendor terms | **Models → CLIs** |

Most of these allowances, apart from Copilot, ChatGPT and Cursor, come from third-party listings rather than the providers' own pages, and free tiers change faster than paid ones. Your account's current limits are on each provider's dashboard.

**Gemini in Minnow:** add a **Custom** provider with base URL `https://generativelanguage.googleapis.com` and a key from [Google AI Studio](https://aistudio.google.com). Under **Advanced settings**, set the models path to `/v1beta/openai/models` and the chat path to `/v1beta/openai/chat/completions`.

### A free setup that holds up

One free tier alone runs out quickly in agent work, because every tool round is a request. Combine two or three:

1. Add Gemini, OpenRouter and Groq as providers.
2. In **Models → Routers**, make a router with a free model from each. When one entry fails, the router can move the chat to another ([Model routers](connect-a-model.md#model-routers)).
3. Select the router in the model picker.
4. Bind **Utility tasks** in **Models → Routing** to a small local model or Groq, so chat titles and commit messages do not use your daily requests.

If you have even modest hardware, adding a local model to the router gives you a fallback that never runs out.

## Local hardware

Local models cost nothing per token, never hit a limit, and are the only option where nothing leaves your machine. Minnow can download and serve them itself ([Serve a model inside Minnow](connect-a-model.md#serve-a-model-inside-minnow)), or use LM Studio or Ollama.

**Memory decides what you can run.** On a PC that means GPU VRAM; on a Mac or other unified-memory machine it means total RAM. **Models → Discover → Recommended** estimates what fits your machine at the context length you choose, so start there rather than with the table below. Agent work needs a long context (32K tokens or more), and that context takes memory on top of the model.

| Memory | Typical hardware | What it runs well |
|--------|------------------|-------------------|
| 8–16 GB | Mid-range GPU, 16 GB Mac | Small models, good for Utility tasks and quick questions. Weak at multi-step tool use |
| 24 GB | RTX 3090/4090, 32 GB Mac | Qwen 3.8 27B. A real coding agent for everyday work |
| 32 GB | RTX 5090 | The same models with much longer context |
| 96–128 GB | AMD Ryzen AI Max (Strix Halo), Mac Studio, NVIDIA DGX Spark | Qwen3.8-Flash-Next, gpt-oss-120b and other 100B-class models; heavily quantized DeepSeek V4 Flash at the edge |

**Generation speed follows memory bandwidth**, not just capacity. Among these large-memory machines, a Mac Studio M5 Max (614 GB/s) or M5 Ultra (1,200 GB/s) generates text much faster than a Strix Halo (256 GB/s) or DGX Spark (273 GB/s), even though all four hold the same models.

### What hardware costs in October 2026

GPU and memory prices are well above launch prices this year. Rough current prices, which vary widely by retailer:

| Hardware | Approx. price |
|----------|---------------|
| Used RTX 3090, 24 GB | $1,200–1,450 |
| RTX 5090, 32 GB (new) | $5,000+ |
| Strix Halo mini PC, 128 GB | $3,300 |
| Mac Studio M5 Max, 128 GB | $5,100 |
| NVIDIA DGX Spark, 128 GB | $4,700–6,950 |

A used RTX 3090 is still the cheapest route to 24 GB.

### Does local save money?

Rarely, if you are buying hardware for it. A $1,300 used RTX 3090 pays for about 5,000 hours of DeepSeek Flash agent work at the rates in the [cost table](#what-an-hour-of-agent-work-costs), before electricity (about $5–10 a month for a few hours of daily use). The models it runs are also weaker than DeepSeek's.

Local makes sense when you **already own the hardware**, when your code **must not leave the machine**, when you want to work **offline**, or when you want a model that **never rate-limits** for background tasks. A local model bound to Utility tasks, with a cloud model for the main chat, combines the advantages of both.

## Spend less, whatever you choose

- **Send background work to a cheap model.** Bind **Utility tasks** in **Models → Routing** to a free, local or small model. Titles, prompt expansion and commit messages do not need a frontier model.
- **Stay on one model within a chat.** Prompt caches belong to one model at one provider. Switching mid-chat makes the next round pay full input price on the whole conversation.
- **Start a new chat for a new task.** Every round resends the conversation, so a long chat costs more per turn than a fresh one.
- **Use DeepSeek off-peak** when you can choose your hours.
- **Prefer prepaid credit.** DeepSeek, OpenRouter and OpenCode Zen bill from a balance, so a runaway agent cannot run up a large bill. Turn off auto-reload if you want a hard cap.
- **Enter your prices.** Add per-million pricing in a provider's **Advanced settings** and **Models → Usage & cost** shows what you have spent, not just token counts.

## Privacy

Every cloud provider on this page, free or paid, receives your prompts and the files the agent reads. Paid API tiers from the major labs generally do not train on your data; many free tiers do. Local models are the only option where nothing leaves your machine. See [Privacy and security](../reference/privacy-and-security.md) for what Minnow itself sends and stores.

## Related

- [Connect a model](connect-a-model.md) — step-by-step setup for every route on this page
- [Models app](../apps/models.md) — Providers, Routing, Routers, and Usage & cost
- [Privacy and security](../reference/privacy-and-security.md)
