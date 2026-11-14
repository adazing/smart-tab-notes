from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime config, loaded from environment variables and backend/.env."""

    # backend/.env, wherever the server is started from.
    model_config = SettingsConfigDict(env_file=Path(__file__).resolve().parent.parent / ".env", extra="ignore")

    openai_api_key: str = ""
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

    @property
    def allowed_origin_list(self) -> list[str]:
        origins = [o.strip() for o in self.allowed_origins.split(",") if o.strip()]
        return origins + [f"chrome-extension://{i.strip()}" for i in self.extension_ids.split(",") if i.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
