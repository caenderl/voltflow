# Build-Context = apps/collector
FROM python:3.12-slim
WORKDIR /app

# git wird für die pip-Installation der anker-solix-api von GitHub benötigt
RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

# Laufzeit-Abhängigkeiten: asyncpg + dotenv (requirements) und die anker-solix-api
# auf einen festen Commit gepinnt (Reproduzierbarkeit + Supply-Chain-Schutz).
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && pip install --no-cache-dir \
       "git+https://github.com/thomluther/anker-solix-api.git@864ea5c061fa5312949756635a3840c1b68cd2bb"

COPY . /app

# Als non-root Benutzer laufen
RUN useradd --create-home --uid 1000 appuser && chown -R appuser:appuser /app
USER appuser

CMD ["python", "collector.py"]
