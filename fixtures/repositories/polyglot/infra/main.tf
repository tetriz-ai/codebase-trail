module "worker" { source = "./worker" }
output "worker_id" { value = module.worker.id }
