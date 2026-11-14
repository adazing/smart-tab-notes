from functools import lru_cache
from pathlib import Path

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime config, loaded from environment variables and backend/.env."""

    # backend/.env, wherever the server is started from.
    model_config = SettingsConfigDict(env_file=Path(__file__).resolve().parent.parent / ".env", extra="ignore")

    # SecretStr so the key never shows up in logs, reprs or test failures.
    openai_api_key: SecretStr = SecretStr("")
    openai_model: str = "gpt-4o-mini"
    allowed_origins: str = ""
    # Comma-separated Chrome extension ids allowed to call the API. Empty means
    # any extension (fine for local development; set it before deploying).
    extension_ids: str = ""

    # Token budgets for build_context.
    page_token_budget: int = 1500
    tabs_token_budget: int = 2000
    per_tab_token_budget: int = 600
    selection_token_budget: int = 600

    # Chat (/chat) and tab suggestions (/rank-tabs).
    embedding_model: str = "text-embedding-3-small"
    chat_top_k: int = 8
    # Each tab's best chunk is guaranteed a place if it scores at least this
    # fraction of the best chunk overall.
    chat_tab_relevance: float = 0.75
    chat_context_tokens: int = 3500
    chat_history_messages: int = 10
    rank_suggest_threshold: float = 0.3

    # Every OpenAI call: give up after this many seconds (one retry), and cap
    # how long an answer can get.
    openai_timeout_s: float = 30
    answer_max_tokens: int = 700

    @property
    def allowed_origin_list(self) -> list[str]:
        origins = [o.strip() for o in self.allowed_origins.split(",") if o.strip()]
        return origins + [f"chrome-extension://{i.strip()}" for i in self.extension_ids.split(",") if i.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
