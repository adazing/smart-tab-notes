# Smart Tab Notes API

Base URL (local dev): `http://localhost:8000`

All bodies are JSON. CORS allows any `chrome-extension://` origin, plus any origins listed in `ALLOWED_ORIGINS` in `backend/.env`.

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
| `selected_text` | string | yes | The highlighted text. Must not be empty. |
| `page_text` | string | no | Readable text of the current page. The backend trims it to a window around the selection. |
| `other_tabs` | array of Tab | no | Other open tabs. Tabs with empty `text` are ignored. |

**Tab**

| Field | Type | Notes |
|---|---|---|
| `tab_id` | integer | Chrome tab id |
| `title` | string | |
| `url` | string | |
| `text` | string | Readable text of the tab. The backend keeps the most relevant tabs and trims each to fit a token budget. |

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
| 422 | Invalid body (for example, missing or empty `selected_text`) | FastAPI validation error |
| 503 | Backend has no OpenAI key configured | `{ "detail": "OPENAI_API_KEY is not set. Add it to backend/.env." }` |
| 502 | The LLM call failed | `{ "detail": "The explanation service failed. Try again." }` |

## Example

```bash
curl -s http://localhost:8000/explain \
  -H 'Content-Type: application/json' \
  -d '{"selected_text":"backpropagation","page_text":"Networks are trained with backpropagation.","other_tabs":[{"tab_id":7,"title":"Gradient descent","url":"https://example.com/gd","text":"Gradient descent updates weights to reduce error."}]}'
```
