# Build context = apps/collector
FROM python:3.12-slim
WORKDIR /app

# git is required for the pip install of anker-solix-api from GitHub
RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

# Runtime dependencies: asyncpg + dotenv (requirements) and anker-solix-api
# pinned to a fixed commit (reproducibility + supply-chain protection).
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && pip install --no-cache-dir \
       "git+https://github.com/thomluther/anker-solix-api.git@864ea5c061fa5312949756635a3840c1b68cd2bb"

COPY . /app

# Run as a non-root user
RUN useradd --create-home --uid 1000 appuser && chown -R appuser:appuser /app
USER appuser

CMD ["python", "collector.py"]
