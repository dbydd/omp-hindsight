#!/bin/bash
# 测试实例入口包装。
#
# 官方 1.1.0 镜像不带 VectorChord，也不在 shared_preload_libraries 里预加载它；
# 而 2048 维嵌入（nvidia/nemotron-3-embed-1b）在 pgvector 的 HNSW 上建不了索引
# （pgvector 上限 2000 维）。所以这里把挂进来的 vchord 文件铺进 pg0 的安装目录。
#
# 先有鸡还是先有蛋：pg0 的 installation/<version>/ 目录只在它第一次拿到数据卷时
# 才解出来，而 shared_preload_libraries 必须在 postgres 启动前就写进配置。
# 处理办法是：安装目录不存在时，先让 pg0 起一次再停掉（只为把目录解出来），
# 铺完文件、写好配置，最后才 exec 真正的 start-all.sh。
set -e

SEED=/opt/vchord-seed
DATA_DIR=/home/hindsight/.pg0
PG0=/app/api/.venv/lib/python3.11/site-packages/pg0/bin/pg0

as_hindsight() {
  su -m hindsight -s /bin/bash -c "export HOME=/home/hindsight; $*"
}

stage_vchord() {
  local pgroot
  pgroot="$(ls -d ${DATA_DIR}/installation/*/ 2>/dev/null | head -1)"
  [ -n "$pgroot" ] || return 0
  [ -f "$SEED/vchord.so" ] || return 0
  mkdir -p "${pgroot}share/extension"
  cp -f "$SEED/vchord.so" "${pgroot}lib/"
  cp -f "$SEED/vchord.control" "$SEED"/vchord--*.sql "${pgroot}share/extension/" 2>/dev/null || true
  echo "[entrypoint] vchord staged into ${pgroot}"
}

patch_preload() {
  local conf
  for conf in ${DATA_DIR}/instances/*/data/postgresql.conf ${DATA_DIR}/postgresql.conf; do
    [ -f "$conf" ] || continue
    grep -q "^shared_preload_libraries" "$conf" ||
      printf "\n# VectorChord 必须预加载，否则 CREATE EXTENSION 报错\nshared_preload_libraries = 'vchord'\n" >> "$conf"
  done
}

if ! ls -d ${DATA_DIR}/installation/*/ > /dev/null 2>&1; then
  echo "[entrypoint] pg0 installation 尚未解出，先起停一次以物化安装目录"
  as_hindsight "$PG0 start --name hindsight --data-dir ${DATA_DIR} --username postgres --password postgres --database postgres" || true
  as_hindsight "$PG0 stop --name hindsight" || true
fi

stage_vchord
patch_preload

exec /app/start-all.sh
