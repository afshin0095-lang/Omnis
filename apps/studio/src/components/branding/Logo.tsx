import { motion } from "motion/react";

export default function Logo() {
  return (
    <motion.h1
      className="welcome-title"
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        duration: 0.8,
      }}
    >
      OMNIS
    </motion.h1>
  );
}