from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime config, loaded from environment variables and backend/.env."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    openai_api_key: str = ""
    openai_model: str = "gpt-4o-mini"
    allowed_origins: str = ""

    # Token budgets for build_context.
    page_token_budget: int = 1500
    tabs_token_budget: int = 2000
    per_tab_token_budget: int = 600

    # Chat (/chat) and tab suggestions (/rank-tabs).
    embedding_model: str = "text-embedding-3-small"
    chat_top_k: int = 8
    chat_context_tokens: int = 3500
    chat_history_messages: int = 10
    rank_suggest_threshold: float = 0.3

    @property
    def allowed_origin_list(self) -> list[str]:
        return [o.strip() for o in self.allowed_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
