# ZenPDF API/worker image for Railway. Build context = repo root.
# Mirrors infra/docker/api.Dockerfile (prod target) with root-relative paths.
ARG PYTHON_IMAGE=python:3.14-slim
FROM ${PYTHON_IMAGE}
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
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
