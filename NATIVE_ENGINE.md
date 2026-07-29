# Native PDF Engine API

The local engine is served by `server.py` on the same origin as the web app.

## Health

`GET /api/health`

Returns engine availability, versions, upload limit, and supported operations.

## Analyse a PDF

`POST /api/pdf/analyze` using `multipart/form-data` with a `file` part.

The response includes page count, metadata, document permissions, repair state, AcroForm fields, and signature indicators.

## Edit a PDF

`POST /api/pdf/edit` using `multipart/form-data` with:

- `file`: the source PDF.
- `operations`: a JSON document containing an `operations` array.

Example:

```json
{
  "operations": [
    {
      "type": "replace_text",
      "page": 0,
      "search": "Old text",
      "replacement": "New text",
      "occurrence": "all"
    },
    {
      "type": "set_form_field",
      "name": "customer_name",
      "value": "Ada Lovelace"
    }
  ]
}
```

Supported operation types:

- `replace_text`
- `set_form_field`
- `set_metadata`
- `add_text`

Page indexes are zero-based at the API boundary. Requests are limited to 100 operations. Signed-PDF mutation is rejected by default.
