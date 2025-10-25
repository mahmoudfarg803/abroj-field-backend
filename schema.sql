CREATE TABLE IF NOT EXISTS roles (id TINYINT PRIMARY KEY, name VARCHAR(20) NOT NULL UNIQUE);
INSERT IGNORE INTO roles (id, name) VALUES (1,'admin'),(2,'manager'),(3,'employee');
