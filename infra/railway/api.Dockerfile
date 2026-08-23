# ZenPDF API/worker image for Railway. Build context = repo root.
# Mirrors infra/docker/api.Dockerfile (prod target) with root-relative paths.
ARG PYTHON_IMAGE=python:3.14-slim
FROM ${PYTHON_IMAGE}
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
# The proxy hop, written where a redeploy reads it (docs/ops/railway.md gotcha 4).
# **`NUM_PROXIES=3`** — the value measured against the running stack, not the 1
# this image inherited from `base.py` or the 2 the deploy plan predicted. The
# chain is browser → Railway edge → our nginx → gunicorn, and `client_ip` counts
# from the right, so an undercount reads a proxy's address as the client and
# every throttle and the admin allowlist key on the wrong one. If you put another
# proxy (Cloudflare) in front, raise it again.
#
# It lives in the image because nothing under `infra/railway/` set it and the
# real value existed only in the Railway dashboard: a project rebuilt from this
# repo would have got the repo default of 1 and silently collapsed every per-IP
# throttle onto the edge's address — the QA report's H1 failure, re-armed. A
# service variable still overrides this, which is how a topology change is made.
ENV NUM_PROXIES=3
ARG OCR_EXTRA_LANGS=""
RUN apt-get update && apt-get install -y --no-install-recommends \
        tesseract-ocr tesseract-ocr-eng tesseract-ocr-heb tesseract-ocr-deu \
        tesseract-ocr-fra tesseract-ocr-spa ${OCR_EXTRA_LANGS} \
        ghostscript unpaper pngquant qpdf \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY backend/requirements/ requirements/
RUN pip install -r requirements/prod.txt
RUN useradd --create-home --uid 1000 appuser
COPY backend/ .
RUN chown -R appuser:appuser /app
USER appuser
EXPOSE 8000
# Default = api. Railway start commands (plan D6) override this per service.
CMD ["sh", "-c", "gunicorn config.wsgi:application --bind [::]:${PORT:-8000} --workers 4 --timeout 120"]
