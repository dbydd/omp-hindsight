# 测试实例

`hindsight-omp` 的写入验收（retain、kb/mm 建对象、队列投递）不能落在日常使用的
8888 实例上，所以这里单独起一套：

| | 现役 | 这里 |
|---|---|---|
| 端口 | 8888 | 18888 |
| 容器 | `hindsight` | `hindsight-test` |
| 数据卷 | `local_container_services/data/hindsight` | `./data` |
| 镜像 | 自构建 `hindsight:local`（1.0 + 本地补丁） | 官方 `ghcr.io/vectorize-io/hindsight:1.1.0` |

两边不共享卷、网络别名与容器名，删掉这套不影响现役实例。

参数沿用 `_retired-container-dir/docker`（第一轮迁移实测过的那套），差异只有镜像版本与
VectorChord 的引入方式。

## 起停

```bash
cp .env.example .env    # 填三个 key，确认 VCHORD_SRC 指向 vchord 文件
docker compose up -d
curl -s localhost:18888/health/ready
docker compose down     # 数据留在 ./data，下次启动还在
rm -rf ./data           # 彻底清空（容器已停的情况下）
```

## 1.1.0 官方镜像与现役自构建的差别

现役镜像是 `hindsight:local`，在官方 1.0.0 上打了两个补丁并内置 VectorChord。官方 1.1.0：

- **NVIDIA reranker 已内置**（`NvidiaCrossEncoder`、`DEFAULT_RERANKER_NVIDIA_*`），
  旧补丁 `0001-nvidia-nim-reranker.patch` 不需要；本 compose 用 `rrf` 直通，
  验收阶段不花外网调用。
- **VectorChord 不带**：`pg0` 的扩展目录里只有 `pgvector_compiled` 与 `pgvecto.rs`。
  2048 维嵌入在 pgvector 的 HNSW 上建不了索引（上限 2000 维），所以外挂 vchord。
- **抽取模型要换**：`group/generic-writer` 是思考模型，长文档抽取会超时，
  沿用第一轮实验的 `group/fusion-worker` + `LLM_TIMEOUT=900`。

## entrypoint.sh 做两件事

1. **铺 vchord**：把挂载在 `/opt/vchord-seed` 的 `vchord.so` / `vchord.control` / `vchord--*.sql`
   拷进 pg0 的 `installation/<ver>/{lib,share/extension}`。
2. **写 preload**：在 pg0 的 `instances/*/data/postgresql.conf` 补
   `shared_preload_libraries = 'vchord'`（不预加载时 `CREATE EXTENSION vchord` 直接报错）。

pg0 的安装目录只在容器第一次拿到数据卷时才解出来，而 preload 必须在 postgres 启动前写好，
所以安装目录缺失时 entrypoint 会先用 `pg0 start/stop` 把目录物化一次，再铺文件、写配置，
最后才 exec 真正的 `start-all.sh`。首次启动因此比后续慢一轮，属预期。

## 替代方案

不想外挂 vchord，就把嵌入换成 ≤2000 维的模型并设 `HINDSIGHT_API_VECTOR_EXTENSION=pgvector`。
维度和模型必须一起换，否则索引建不起来。

## hindsight-omp 指向这里

项目 `.omp/hindsight-omp.json` 写 `baseUrl: http://127.0.0.1:18888` 即可，
插件不会碰 8888。验收完把配置换回现役实例或删掉。
