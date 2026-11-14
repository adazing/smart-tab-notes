# Sample tabs

`tabs.json` is three real pages in the shape `/chat` expects, extracted and chunked
by the extension's own `extractPage` and `chunkBlocks` (ticket #5), with tab ids
101 to 103:

| tab_id | Page | Chunks |
| --- | --- | --- |
| 101 | [Backpropagation](https://en.wikipedia.org/wiki/Backpropagation) (Wikipedia) | 27 |
| 102 | [Gradient descent](https://en.wikipedia.org/wiki/Gradient_descent) (Wikipedia) | 22 |
| 103 | [9. Classes](https://docs.python.org/3/tutorial/classes.html) (Python tutorial) | 22 |

Used by `tests/test_chat.py` and `scripts/chat_smoke.py`. Wikipedia text is
CC BY-SA 4.0; the Python documentation is under the PSF license.
