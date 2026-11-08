output "vpc_id" {
  description = "VPC id"
  value       = aws_vpc.this.id
}

output "vpc_cidr" {
  description = "VPC CIDR"
  value       = aws_vpc.this.cidr_block
}

output "public_subnet_ids" {
  description = "Public subnet ids"
  value       = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  description = "Private subnet ids"
  value       = aws_subnet.private[*].id
}

output "alb_sg_id" {
  description = "ALB security group id"
  value       = aws_security_group.alb.id
}

output "app_sg_id" {
  description = "App security group id"
  value       = aws_security_group.app.id
}

output "db_sg_id" {
  description = "DB security group id"
  value       = aws_security_group.db.id
}
