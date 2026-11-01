#!/bin/bash
# 测试实例入口包装。
#
# 官方 1.1.0 镜像不带 VectorChord（2048 维嵌入必需的扩展：pgvector 的 HNSW 上限 2000 维），
# 而 pg0 的安装目录只在运行时从数据卷里解出来，构建期没有位置可写。所以启动前把挂在
# /opt/vchord-seed 的 vchord 文件铺进 pg0 的 installation/<ver>/{lib,share/extension}。
#
# shared_preload_libraries 不在这里改配置文件，而是由 compose 里的
# HINDSIGHT_API_DATABASE_URL=pg0?shared_preload_libraries=vchord 交给 pg0 自己写进
# 启动参数——pg0 的 URL 查询串就是 postgresql.conf 设置，比事后改 conf 可靠。
set -e

SEED=/opt/vchord-seed
DATA_DIR=/home/hindsight/.pg0
PG0=/app/api/.venv/lib/python3.11/site-packages/pg0/bin/pg0

# pg0 的安装目录要等它跑过一次才会解出来；没有就先起停一次（失败也无妨，只为止解包）。
if ! ls -d ${DATA_DIR}/installation/*/ > /dev/null 2>&1; then
  echo "[entrypoint] pg0 installation 尚未解出，先起停一次以物化安装目录"
  "$PG0" start --name hindsight --data-dir "$DATA_DIR" \
    --username postgres --password postgres --database postgres || true
  "$PG0" stop --name hindsight || true
fi

pgroot="$(ls -d ${DATA_DIR}/installation/*/ 2>/dev/null | head -1)"
if [ -n "$pgroot" ] && [ -f "$SEED/vchord.so" ]; then
  mkdir -p "${pgroot}share/extension"
  cp -f "$SEED/vchord.so" "${pgroot}lib/"
  cp -f "$SEED/vchord.control" "$SEED"/vchord--*.sql "${pgroot}share/extension/" 2>/dev/null || true
  echo "[entrypoint] vchord staged into ${pgroot}"
else
  echo "[entrypoint] vchord 未铺装：pgroot=${pgroot:-<none>} seed=$([ -f "$SEED/vchord.so" ] && echo ok || echo missing)"
fi

exec /app/start-all.sh
