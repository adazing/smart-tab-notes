# Smart Tab Notes API

Base URL (local dev): `http://localhost:8000`

All bodies are JSON. CORS allows the extension ids listed in `EXTENSION_IDS` in `backend/.env` (find yours at `chrome://extensions`), plus any origins in `ALLOWED_ORIGINS`. While `EXTENSION_IDS` is empty, any Chrome extension is allowed and the server logs a warning: fine for local development, not for a deployed backend.

## GET /health

Liveness check.

**Response 200**

```json
{ "status": "ok" }
```

## POST /explain

Explains a highlighted passage in plain language (2 to 4 sentences), using the current page and, when helpful, other open tabs.

**Request**

| Field | Type | Required | Notes |
|---|---|---|---|
| `selected_text` | string | yes | The highlighted text. 1 to 20,000 characters. Matched in the page ignoring case and whitespace, so a selection across paragraphs is found. Only the first ~600 tokens are sent to the model. |
| `page_text` | string | no | Readable text of the current page, up to 1,000,000 characters. The backend trims it to a window of at most 1,500 tokens around the selection. |
| `other_tabs` | array of Tab | no | Up to 20 other open tabs. Tabs with empty `text` are ignored. |

**Tab**

| Field | Type | Notes |
|---|---|---|
| `tab_id` | integer | Chrome tab id |
| `title` | string | Up to 1,000 characters. |
| `url` | string | Up to 4,096 characters. |
| `text` | string | Up to 300,000 characters. Readable text of the tab. The backend keeps the most relevant tabs and trims each to fit a token budget. |

```json
{
  "selected_text": "backpropagation",
  "page_text": "… Networks are trained with backpropagation and gradient descent …",
  "other_tabs": [
    { "tab_id": 7, "title": "Gradient descent", "url": "https://example.com/gd", "text": "Gradient descent updates weights …" }
  ]
}
```

**Response 200**

| Field | Type | Notes |
|---|---|---|
| `explanation` | string | Plain-language explanation, 2 to 4 sentences. |
| `used_tab_ids` | integer[] | Ids from `other_tabs` that the explanation drew on, in order of first use. Empty if only the current page was used. |

```json
{
  "explanation": "Backpropagation is how a neural network learns from its mistakes. It works out how much each weight contributed to the error so gradient descent can adjust it.",
  "used_tab_ids": [7]
}
```

**Errors**

| Status | When | Body |
|---|---|---|
| 422 | Invalid body: missing or empty `selected_text`, or any field over its size limit | FastAPI validation error |
| 503 | Backend has no OpenAI key configured | `{ "detail": "OPENAI_API_KEY is not set. Add it to backend/.env." }` |
| 502 | The LLM call or anything else on the server failed | `{ "detail": "The explanation service failed. Try again." }` |

## Example

```bash
curl -s http://localhost:8000/explain \
  -H 'Content-Type: application/json' \
  -d '{"selected_text":"backpropagation","page_text":"Networks are trained with backpropagation.","other_tabs":[{"tab_id":7,"title":"Gradient descent","url":"https://example.com/gd","text":"Gradient descent updates weights to reduce error."}]}'
```
