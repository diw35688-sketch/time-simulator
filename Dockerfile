# 魔搭创空间（Docker 类型）用：只依赖 Python 标准库，服务监听 0.0.0.0:7860
FROM python:3.11-slim
WORKDIR /app
COPY . .
# 部署脚本把超过 4MB 的模型文件拆成了几块，这里拼回去
RUN python tools/join_parts.py vendor/mediapipe
ENV TIMESPELL_PUBLIC=1 PYTHONUNBUFFERED=1
EXPOSE 7860
CMD ["python", "server.py", "7860"]
