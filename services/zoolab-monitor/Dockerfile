FROM python:3.13-alpine

WORKDIR /app
COPY app.py /app/app.py
COPY zoolab_monitor /app/zoolab_monitor
COPY config /app/config

RUN addgroup -S zoolab && adduser -S -G zoolab zoolab \
    && mkdir -p /app/data && chown zoolab:zoolab /app/data

USER zoolab
EXPOSE 8090

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8090/health', timeout=2)"

CMD ["python", "-u", "app.py", "--config", "config/services.json"]
