# SMA PV inverter collector (Speedwire).  Build context = apps/collector
FROM python:3.14-slim
WORKDIR /app

# Runtime deps only (no git / anker-solix-api needed for this collector), at
# the exact versions in the lockfile - see scripts/lock-collector-deps.sh.
COPY requirements-sma.lock ./
RUN pip install --no-cache-dir -r requirements-sma.lock

COPY . /app

# Run as a non-root user
RUN useradd --create-home --uid 1000 appuser && chown -R appuser:appuser /app
USER appuser

ENV COLLECTOR=sma
CMD ["python", "collector.py"]
